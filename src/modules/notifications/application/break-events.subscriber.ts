import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { time12InZone } from '@shared/utils/timezone';
import { BreakApprovalRequestedEvent } from '@modules/shifts/domain/events/break-approval-requested.event';
import { BreakDecidedEvent } from '@modules/shifts/domain/events/break-decided.event';
import { RecordKind, RECORD_LABEL } from '@modules/shifts/domain/shift.types';
import { ApprovalsDigestEvent } from '@modules/worktime/domain/events/approvals-digest.event';
import {
  autoSkipRequestedCopy,
  Copy,
  NO_NOTE_YET,
  NOTICE,
  skipRequestedCopy,
} from '@modules/worktime/domain/notice-copy';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationsGateway } from '../presentation/notifications.gateway';
import { NotificationMapper } from './notification.mapper';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-13" -> "13 Oct". */
export function shortDate(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${d} ${MONTHS[m - 1]}` : dateKey;
}

/** 3.3: the decision's effect on focus time, said plainly (staff read "approved" as "+15 min"). */
export function effectSentence(effect: BreakDecidedEvent['effect']): string | null {
  if (!effect) return null;
  const m = `${effect.minutes} min`;
  switch (effect.mode) {
    case 'PLUS':
      return `${m} added back to your focus time.`;
    case 'MINUS':
      return `${m} taken off your focus time for that day.`;
    case 'KEPT':
      return `The ${m} you worked through the break stay counted as focus time, so the total does not change.`;
    default:
      return 'No change to your focus time.';
  }
}

function breakName(kind: RecordKind | null): string {
  return kind ? RECORD_LABEL[kind].toLowerCase() : 'unscheduled break';
}

/** C-860 to C-865: a break taken, or one that ran over. */
function takenCopy(e: BreakApprovalRequestedEvent): Copy {
  let title: string;
  if (e.overrun) {
    title = `${e.subjectName}'s ${breakName(e.kind)} was extended`;
  } else if (e.timing === 'LATE' || e.timing === 'EARLY') {
    title = `${e.subjectName} started the ${breakName(e.kind)} ${e.minutesOff} min ${e.timing === 'LATE' ? 'after its time' : 'early'}`;
  } else {
    title = `${e.subjectName} took a break outside the break windows`;
  }
  return { title, body: e.reason ? `Reason: ${e.reason}` : NO_NOTE_YET };
}

/**
 * What the approver reads. A skip only comes this way when it is sent again to a new approver
 * (ApprovalRerouteSubscriber), and then reads as it did the first time (C-868 to C-871).
 */
function requestNotice(e: BreakApprovalRequestedEvent): Copy & { type: string } {
  const name = e.subjectName;
  switch (e.outcome) {
    case 'SKIPPED':
      return {
        type: NOTICE.SKIP_REQUESTED,
        ...skipRequestedCopy({ name, kind: e.kind, reason: e.reason }),
      };
    case 'AUTO_SKIPPED':
      return {
        type: NOTICE.AUTO_SKIP_REQUESTED,
        ...autoSkipRequestedCopy({ name, kind: e.kind, at: time12InZone(e.startedAt) }),
      };
    default:
      return { type: 'BREAK_APPROVAL_REQUESTED', ...takenCopy(e) };
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Bell and realtime notifications for scheduled breaks:
 *  - an approver hears about a late or early break (or an overrun) to decide;
 *  - the person hears the decision;
 *  - every approver gets one daily reminder of what is still waiting (pending,
 *    due within 24 hours, overdue; breaks and meetings).
 */
@Injectable()
export class BreakEventsSubscriber implements OnModuleInit {
  private readonly logger = new Logger(BreakEventsSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<BreakApprovalRequestedEvent>(BreakApprovalRequestedEvent.eventName, (e) =>
      this.requested(e),
    );
    this.events.subscribe<BreakDecidedEvent>(BreakDecidedEvent.eventName, (e) => this.decided(e));
    this.events.subscribe<ApprovalsDigestEvent>(ApprovalsDigestEvent.eventName, (e) =>
      this.digest(e),
    );
  }

  private async push(
    userId: string,
    type: string,
    title: string,
    body: string,
    fromUserId: string | null,
  ) {
    const saved = await this.notifications.create({ userId, type, title, body, fromUserId });
    this.gateway.emitToUser(userId, NotificationMapper.toView(saved));
  }

  async requested(e: BreakApprovalRequestedEvent): Promise<void> {
    const { type, title, body } = requestNotice(e);
    for (const id of new Set(e.recipientIds)) {
      if (id === e.subjectId) continue;
      await this.push(id, type, title, body, e.subjectId);
    }
    this.logger.debug(`break ${e.recordId} sent to ${e.recipientIds.length} approver(s)`);
  }

  async decided(e: BreakDecidedEvent): Promise<void> {
    const verdict = e.decision === 'APPROVED' ? 'approved' : 'not approved';
    const what =
      e.outcome && e.outcome !== 'TAKEN' ? `skipped ${breakName(e.kind)}` : breakName(e.kind);
    const title = `Your ${what} on ${shortDate(e.date)} was ${verdict}`;
    const effect = effectSentence(e.effect);
    const by = e.note ? `${e.deciderName}: ${e.note}` : `By ${e.deciderName}.`;
    const body = effect ? `${effect} ${by}` : by;
    await this.push(e.subjectId, 'BREAK_DECIDED', title, body, e.deciderId);
  }

  /** The 18:30 digest (3.1): pending, due within 24 hours, overdue; breaks and meetings. */
  async digest(e: ApprovalsDigestEvent): Promise<void> {
    if (e.pending <= 0) return;
    const title = `${plural(e.pending, 'approval')} waiting`;
    const body =
      `${e.pending} pending, ${e.dueSoon} due within 24 hours, ${e.overdue} past their time. ` +
      'Review them in Approvals.';
    await this.push(e.recipientId, 'BREAK_APPROVALS_DIGEST', title, body, null);
  }
}
