import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { BreakApprovalRequestedEvent } from '@modules/shifts/domain/events/break-approval-requested.event';
import { BreakDecidedEvent } from '@modules/shifts/domain/events/break-decided.event';
import { BREAK_LABEL, BreakKind } from '@modules/shifts/domain/shift.types';
import { ApprovalsDigestEvent } from '@modules/worktime/domain/events/approvals-digest.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationsGateway } from '../presentation/notifications.gateway';
import { NotificationMapper } from './notification.mapper';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-13" -> "13 Oct". */
export function shortDate(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return m >= 1 && m <= 12 ? `${d} ${MONTHS[m - 1]}` : dateKey;
}

function breakName(kind: BreakKind | null): string {
  return kind ? BREAK_LABEL[kind].toLowerCase() : 'an unscheduled break';
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
    let title: string;
    if (e.overrun) {
      title = `${e.subjectName}'s ${breakName(e.kind)} ran over`;
    } else if (e.timing === 'LATE' || e.timing === 'EARLY') {
      title = `${e.subjectName} started the ${breakName(e.kind)} ${e.minutesOff} min ${e.timing === 'LATE' ? 'late' : 'early'}`;
    } else {
      title = `${e.subjectName} took a break outside the break windows`;
    }
    const body = e.reason ? `Reason: ${e.reason}` : 'No reason given. Review it in Approvals.';
    for (const id of new Set(e.recipientIds)) {
      if (id === e.subjectId) continue;
      await this.push(id, 'BREAK_APPROVAL_REQUESTED', title, body, e.subjectId);
    }
    this.logger.debug(`break ${e.recordId} sent to ${e.recipientIds.length} approver(s)`);
  }

  async decided(e: BreakDecidedEvent): Promise<void> {
    const verdict = e.decision === 'APPROVED' ? 'approved' : 'rejected';
    const what =
      e.outcome && e.outcome !== 'TAKEN' ? `skipped ${breakName(e.kind)}` : breakName(e.kind);
    const title = `Your ${what} on ${shortDate(e.date)} was ${verdict}`;
    const body = e.note ? `${e.deciderName}: ${e.note}` : `By ${e.deciderName}.`;
    await this.push(e.subjectId, 'BREAK_DECIDED', title, body, e.deciderId);
  }

  /** The 18:30 digest (3.1): pending, due within 24 hours, overdue; breaks and meetings. */
  async digest(e: ApprovalsDigestEvent): Promise<void> {
    if (e.pending <= 0) return;
    const title = `${plural(e.pending, 'approval')} waiting`;
    const body =
      `${e.pending} pending, ${e.dueSoon} due within 24 hours, ${e.overdue} overdue. ` +
      'Review them in Approvals.';
    await this.push(e.recipientId, 'BREAK_APPROVALS_DIGEST', title, body, null);
  }
}
