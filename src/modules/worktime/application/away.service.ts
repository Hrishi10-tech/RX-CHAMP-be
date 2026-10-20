import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { RequestClock } from '@shared/tenancy';
import { appTimezone, time12InZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { REASON_FIELDS } from '@modules/settings/domain/idle.rules';
import { BreakApprovalPolicy } from '@modules/shifts/application/break-approval.policy';
import { BreakEvents, personName } from '@modules/shifts/application/break-events.service';
import { MyBreaksUseCase } from '@modules/shifts/application/use-cases/my-breaks.use-case';
import { pendingClock } from '@modules/shifts/infrastructure/prisma-break-record.repository';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import { AWAY_REPOSITORY, AwayKind, AwayRepository, AwayRow } from '../domain/away.repository';
import { cleanParticipants, cleanText } from '../domain/meetings';
import { NOTICE } from '../domain/notice-copy';
import { WORKTIME_READER, WorktimeReader } from '../domain/worktime.reader';
import { SubmitAwayDto } from './dto/away.dto';
import { WorkSessionsService } from './work-sessions.service';

/** The longest away stretch the server accepts in one answer (a working day). */
const MAX_AWAY_MS = 16 * 3_600_000;
/** An away start may be at most this far ahead of the event time (clock skew). */
const SKEW_MS = 2 * 60_000;

export interface AwayView {
  id: string;
  date: string;
  startedAt: string;
  endedAt: string | null;
  seconds: number;
  reasonKey: string | null;
  reasonKind: string | null;
  reasonLabel: string | null;
  comment: string | null;
  participants: { id?: string; name: string }[];
  momSender: string | null;
  status: string;
  decidedAt: string | null;
  decisionNote: string | null;
}

export function awayView(a: AwayRow): AwayView {
  return {
    id: a.id,
    date: a.date,
    startedAt: a.startedAt.toISOString(),
    endedAt: a.endedAt?.toISOString() ?? null,
    seconds: a.seconds ?? 0,
    reasonKey: a.reasonKey,
    reasonKind: a.reasonKind,
    reasonLabel: a.reasonLabel,
    comment: a.comment,
    participants: a.participants.map((p) => (p.id ? { id: p.id, name: p.name } : { name: p.name })),
    momSender: a.momSender,
    status: a.status,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    decisionNote: a.decisionNote,
  };
}

/**
 * Away (input) tracking (docs/4.0/SPEC.md 2.5): the agent's pop-up answers.
 * "Took a break" becomes a quick break back-dated to the away start; every other
 * reason records an away stretch from the away start to the answer, waiting for
 * approval (it counts as focus only once approved). An unanswered pop-up is
 * recorded UNEXPLAINED.
 */
@Injectable()
export class AwayService {
  private readonly logger = new Logger(AwayService.name);

  constructor(
    @Inject(AWAY_REPOSITORY) private readonly away: AwayRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly sessions: WorkSessionsService,
    private readonly settings: AppSettingsService,
    private readonly breaks: MyBreaksUseCase,
    private readonly breakEvents: BreakEvents,
  ) {}

  /** The open working day and a start bounded by it (and not in the future). */
  private async bounds(userId: string, startedAt: Date, now: Date, reasonKey?: string) {
    if (Number.isNaN(startedAt.getTime())) {
      throw new ValidationError('startedAt must be an ISO-8601 instant.').withDetails({
        field: 'startedAt',
      });
    }
    if (startedAt.getTime() > now.getTime() + SKEW_MS) {
      throw new UnprocessableError('The away start is in the future.', 'AWAY_TIME_INVALID');
    }
    if (now.getTime() - startedAt.getTime() > MAX_AWAY_MS) {
      throw new UnprocessableError('The away start is too long ago.', 'AWAY_TIME_INVALID');
    }
    const open = await this.sessions.findOpen(userId);
    if (!open) throw new ConflictError('Start your day first.', 'DAY_NOT_STARTED');
    // Bounded by the day start and the end of the last break or meeting (the last
    // time the person was accounted for), so away time never overlaps them.
    const presence = await this.reader.presenceOverlapping([userId], startedAt, now);
    const lastEnd = presence
      .filter((p) => p.endedAt && p.endedAt.getTime() <= now.getTime())
      .reduce((max, p) => Math.max(max, p.endedAt!.getTime()), 0);
    if (presence.some((p) => p.endedAt === null)) {
      throw new ConflictError("You're on a break or in a meeting.", 'NOT_AWAY');
    }
    let start = new Date(Math.max(startedAt.getTime(), open.startedAt.getTime(), lastEnd));
    if (start.getTime() > now.getTime()) start = now;
    // Away answered before: the same answer again (a retry) is answered with the
    // stored one; a later answer starts where the previous away time ended, so two
    // answers in a row never overlap (the second one can arrive late).
    const earlier = (await this.away.listForUsers([userId], open.date, open.date)).filter(
      (r) => r.startedAt.getTime() < now.getTime(),
    );
    const retryOf = earlier.find(
      (r) => r.reasonKey === reasonKey && Math.abs(r.startedAt.getTime() - start.getTime()) < 1000,
    );
    if (!retryOf) {
      const endOf = (r: AwayRow) =>
        (r.endedAt ?? new Date(r.startedAt.getTime() + (r.seconds ?? 0) * 1000)).getTime();
      const covered = earlier
        .filter((r) => r.startedAt.getTime() <= start.getTime() && endOf(r) > start.getTime())
        .reduce((max, r) => Math.max(max, endOf(r)), 0);
      if (covered > start.getTime()) start = new Date(Math.min(covered, now.getTime()));
    }
    return { open, start, retryOf: retryOf ?? null };
  }

  async submit(me: AuthenticatedUser, dto: SubmitAwayDto) {
    const now = RequestClock.now();
    const config = await this.settings.effectiveIdleFor(me.id);
    const reason = config.reasons.find((r) => r.key === dto.reasonKey);
    if (!reason) {
      throw new UnprocessableError(
        'That reason is not offered to you.',
        'AWAY_REASON_UNKNOWN',
      ).withDetails({
        field: 'reasonKey',
      });
    }
    const { open, start, retryOf } = await this.bounds(
      me.id,
      new Date(dto.startedAt),
      now,
      dto.reasonKey,
    );
    if (retryOf) {
      return { kind: 'AWAY' as const, away: awayView(retryOf), event: awayView(retryOf) };
    }

    if (reason.kind === 'BREAK') {
      // A quick break from the away start; planned length rounds the time away so far up to 5 min.
      const awayMin = Math.max(1, Math.ceil((now.getTime() - start.getTime()) / 60_000));
      const plannedMin = Math.min(60, Math.max(5, Math.ceil(awayMin / 5) * 5));
      const started = await this.breaks.startQuick(me, plannedMin, { startedAt: start });
      return { kind: 'BREAK' as const, break: started.record, presence: started.presence };
    }

    const fields = REASON_FIELDS[reason.kind];
    const problems: string[] = [];
    const comment = cleanText(dto.comment);
    if (fields.includes('comment') && (comment.length < 3 || comment.length > 200))
      problems.push('comment');
    let participants: { id?: string; name: string }[] = [];
    let momSender: string | null = null;
    if (reason.kind === 'MEETING') {
      const ids = (dto.participants ?? []).map((p) => p.id).filter((x): x is string => !!x);
      const known = ids.length
        ? await this.reader.knownPeopleIds(me.companyId, ids)
        : new Set<string>();
      participants = cleanParticipants(dto.participants ?? [], known);
      if (participants.length < 1 || participants.length > 30) problems.push('participants');
      momSender = cleanText(dto.momSender) || null;
      if (!momSender || momSender.length < 2 || momSender.length > 80) problems.push('momSender');
    }
    if (problems.length) {
      throw new UnprocessableError(
        `Fill in ${problems.map((p) => FIELD_LABEL[p] ?? p).join(', ')}.`,
        'AWAY_FIELDS',
      ).withDetails({ fields: problems });
    }

    const subject = await this.people.findById(me.id);
    const route = subject
      ? BreakApprovalPolicy.route(subject)
      : { status: 'NOT_REQUIRED' as const, approverRole: null, approverId: null };
    const pending = route.status === 'PENDING';
    const sla = (await this.settings.forUser(me.id)).approvalSlaHours;
    const result = await this.away.create({
      userId: me.id,
      companyId: subject?.companyId ?? me.companyId ?? null,
      date: open.date,
      startedAt: start,
      endedAt: now,
      reasonKey: reason.key,
      reasonKind: reason.kind as AwayKind,
      reasonLabel: reason.label,
      comment: comment || null,
      participants,
      momSender,
      status: pending ? 'PENDING' : 'NOT_REQUIRED',
      approverRole: pending ? route.approverRole : null,
      dueAt: pending ? pendingClock(now, sla).dueAt : null,
    });
    if (!result.ok) {
      // The agent sent the same answer twice (a retry): answer with what is stored.
      if (
        result.existing.reasonKey === reason.key &&
        Math.abs(result.existing.startedAt.getTime() - start.getTime()) < 1000
      ) {
        return {
          kind: 'AWAY' as const,
          away: awayView(result.existing),
          event: awayView(result.existing),
        };
      }
      throw new ConflictError(
        'That time overlaps away time already recorded.',
        'AWAY_OVERLAP',
      ).withDetails({
        existing: awayView(result.existing),
      });
    }
    if (pending) await this.requested(result.row, subject ? personName(subject) : 'Someone');
    // `event` is the name SPEC 5.6 uses; `away` is kept for the 4.0 portal and agent.
    return { kind: 'AWAY' as const, away: awayView(result.row), event: awayView(result.row) };
  }

  /** The pop-up was never answered (End Day, or the agent shutting down). */
  async unexplained(me: AuthenticatedUser, startedAt: Date, endedAt: Date) {
    const now = RequestClock.now();
    if (Number.isNaN(endedAt.getTime()) || endedAt.getTime() <= startedAt.getTime()) {
      throw new ValidationError('endedAt must be after startedAt.').withDetails({
        field: 'endedAt',
      });
    }
    if (endedAt.getTime() > now.getTime() + SKEW_MS) {
      throw new UnprocessableError('The away end is in the future.', 'AWAY_TIME_INVALID');
    }
    const open = await this.sessions.findOpen(me.id);
    const last = open ?? (await this.sessions.findLastEnded(me.id));
    if (!last) throw new ConflictError('Start your day first.', 'DAY_NOT_STARTED');
    const start = new Date(Math.max(startedAt.getTime(), last.startedAt.getTime()));
    const end = new Date(
      Math.min(endedAt.getTime(), (last.endedAt ?? now).getTime(), now.getTime()),
    );
    if (end.getTime() - start.getTime() < 1000) return { away: null };
    const result = await this.away.create({
      userId: me.id,
      companyId: me.companyId ?? null,
      date: last.date,
      startedAt: start,
      endedAt: end,
      reasonKey: null,
      reasonKind: null,
      reasonLabel: null,
      comment: null,
      participants: [],
      momSender: null,
      status: 'UNEXPLAINED',
      approverRole: null,
      dueAt: null,
    });
    if (!result.ok) return { away: awayView(result.existing) };
    return { away: awayView(result.row) };
  }

  async mine(me: AuthenticatedUser, fromDate: string, toDate: string): Promise<AwayView[]> {
    return (await this.away.listForUsers([me.id], fromDate, toDate)).map(awayView);
  }

  async findOwn(me: AuthenticatedUser, id: string): Promise<AwayView> {
    const row = await this.away.findById(id);
    if (!row || row.userId !== me.id) throw new NotFoundError('Unknown away time');
    return awayView(row);
  }

  private async requested(a: AwayRow, name: string): Promise<void> {
    try {
      const recipients = await this.breakEvents.recipientsFor({
        userId: a.userId,
        approverRole: a.approverRole,
      });
      if (!recipients.length) return;
      const tz = appTimezone();
      const minutes = Math.max(1, Math.round((a.seconds ?? 0) / 60));
      const what = a.reasonLabel ?? 'Other work';
      const title = `${name} was away ${minutes} min: ${what}`;
      const body = `${time12InZone(a.startedAt, tz)} to ${time12InZone(a.endedAt ?? a.startedAt, tz)}${
        a.comment ? ` · ${a.comment}` : ''
      }. Approve it to count it as focus time.`;
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(recipients, NOTICE.AWAY_REQUESTED, title, body, a.userId),
      );
    } catch (err) {
      this.logger.warn(`away request notice for ${a.id} failed: ${(err as Error).message}`);
    }
  }
}

const FIELD_LABEL: Record<string, string> = {
  comment: 'a one-line description (3 to 200 characters)',
  participants: 'who was in the meeting (1 to 30 people)',
  momSender: 'who will mail the minutes (2 to 80 characters)',
};
