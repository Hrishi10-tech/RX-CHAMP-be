import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError, UnprocessableError } from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { addDaysToKey, appTimezone, dateKeyInZone, time12InZone } from '@shared/utils/timezone';
import { BreakApprovalPolicy } from '@modules/shifts/application/break-approval.policy';
import { BreakDay, BreakDayService } from '@modules/shifts/application/break-day.service';
import { BreakEvents, personName } from '@modules/shifts/application/break-events.service';
import { PresenceBridge } from '@modules/shifts/application/presence-bridge.service';
import { ShiftMapper } from '@modules/shifts/application/shift.mapper';
import { BreakRecordView, SkipNeedingComment } from '@modules/shifts/application/shifts.types';
import { minCharsFor } from '@modules/shifts/application/skips-needing-comment.query';
import { cleanReason } from '@modules/shifts/application/use-cases/my-breaks.use-case';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
  isSkipRecord,
  NewBreakRecord,
} from '@modules/shifts/domain/break-record.repository';
import { classifyStart, phaseAt } from '@modules/shifts/domain/break-schedule';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import { SHIFT_REPOSITORY, ShiftRepository } from '@modules/shifts/domain/shift.repository';
import {
  BREAK_KINDS,
  BREAK_LABEL,
  BreakKind,
  BreakSlot,
  isScheduledKind,
  ShiftRecord,
} from '@modules/shifts/domain/shift.types';
import { REASON_MAX_CHARS } from '@modules/shifts/domain/break-schedule';
import { AgentGeneration } from '../domain/agent-generation';
import {
  autoSkipRequestedCopy,
  NOTICE,
  skipCommentCopy,
  skipRequestedCopy,
} from '../domain/notice-copy';
import { planAutoSkips } from '../domain/owed';
import { SKIP_REPOSITORY, SkipRepository } from '../domain/skip.repository';
import { WORK_SESSION_REPOSITORY, WorkSessionRepository } from '../domain/work-session.repository';
import { dayClosedError, WorkSessionsService } from './work-sessions.service';

function lower(kind: BreakKind): string {
  return BREAK_LABEL[kind].toLowerCase();
}

/** Why one End Day comment was refused (details of 422 COMMENT_INVALID). */
type CommentProblem = 'NOT_FOUND' | 'NOT_A_SKIP' | 'TOO_SHORT' | 'TOO_LONG' | 'DUPLICATE';

/** An auto-skip about to be created (planned, not written yet), with its id. */
export interface PlannedAutoSkip {
  record: NewBreakRecord & { id: string };
  person: ShiftPerson;
  slot: BreakSlot;
}

/** An End Day comment that passed the checks, for a skip that exists or is planned. */
export interface CheckedComment {
  id: string;
  text: string;
}

/**
 * The id an auto-skip of (person, working day, kind) is created with: known
 * before it exists, so End Day can list the auto-skips it would make, and take
 * comments on them, without writing anything first (a name-based UUID, version 5
 * layout; the person's own id is part of it, and a skip of someone else reads as
 * unknown either way).
 */
export function autoSkipId(userId: string, date: string, kind: string): string {
  const h = createHash('sha1').update(`rxv:auto-skip:${userId}:${date}:${kind}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * Skipping breaks (SPEC 1.4): the manual skip, the comment on a skip, and the
 * auto-skip of an owed break nobody took (5-minute job, lazily on the day views,
 * and at End Day).
 */
@Injectable()
export class SkipsService {
  private readonly logger = new Logger(SkipsService.name);

  constructor(
    @Inject(SKIP_REPOSITORY) private readonly skips: SkipRepository,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly records: BreakRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepository,
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessionsRepo: WorkSessionRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly days: BreakDayService,
    private readonly sessions: WorkSessionsService,
    private readonly breakEvents: BreakEvents,
    private readonly presence: PresenceBridge,
  ) {}

  // ---- Manual skip ---------------------------------------------------------------

  async skip(
    me: AuthenticatedUser,
    dto: { kind: BreakKind; reason?: string },
    generation: AgentGeneration,
    now: Date,
  ): Promise<{ record: BreakRecordView }> {
    await this.sessions.autoCloseIfStale(me.id, now);
    const person = await this.people.findById(me.id);
    if (!person) throw new NotFoundError('User not found');
    const day = await this.days.dayFor(person, now);
    const shift = day.resolved.shift;
    const slot = day.slots.find((s) => s.kind === dto.kind);
    if (!shift || !slot) {
      throw new ConflictError(
        `No ${lower(dto.kind)} is scheduled for you today.`,
        'BREAK_NOT_SCHEDULED',
      );
    }
    if (!slot.allowSkip) {
      throw new ConflictError(`The ${lower(dto.kind)} cannot be skipped.`, 'SKIP_NOT_ALLOWED');
    }

    const taken = await this.records.listForUserOnDate(person.id, day.dateKey);
    if (taken.some((r) => r.kind === dto.kind)) {
      throw new ConflictError(
        `Your ${lower(dto.kind)} already has a record today.`,
        'BREAK_ALREADY_TAKEN',
      );
    }
    const order = BREAK_KINDS.indexOf(dto.kind);
    const later = taken.find((r) => isScheduledKind(r.kind) && BREAK_KINDS.indexOf(r.kind) > order);
    if (later && isScheduledKind(later.kind)) {
      throw new ConflictError(
        `You've already taken your ${lower(later.kind)}, so the ${lower(dto.kind)} is no longer available.`,
        'BREAK_ORDER',
      );
    }

    const tz = appTimezone();
    const phase = phaseAt(slot, now);
    if (phase === 'UPCOMING') {
      throw new ConflictError(
        `Your ${lower(dto.kind)} opens at ${time12InZone(slot.windowOpen, tz)}.`,
        'BREAK_NOT_OPEN',
      ).withDetails({ opensAt: slot.windowOpen.toISOString() });
    }
    if (phase === 'CLOSED') {
      throw new ConflictError(
        `The ${lower(dto.kind)} window closed at ${time12InZone(slot.windowClose, tz)}.`,
        'BREAK_WINDOW_CLOSED',
      ).withDetails({ closedAt: slot.windowClose.toISOString() });
    }

    // Day state and break state before the reason, so the agent hears the real
    // obstacle first. The transaction checks all of it again. "Today" is the
    // person's shift-day (an overnight shift's early hours belong to the evening).
    const today = day.dateKey;
    const open = await this.sessionsRepo.findOpen(person.id);
    if (!open) {
      if (generation === 'AGENT_31') {
        const sessionsToday = await this.sessionsRepo.listForUserOnDate(person.id, today);
        throw dayClosedError(sessionsToday.length ? 'DAY_ENDED' : 'DAY_NOT_STARTED');
      }
      if (await this.sessionsRepo.dayEndedAt(person.id, today)) throw dayClosedError('DAY_ENDED');
    }
    const current = await this.presence.findOpen(person.id);
    if (current && (current.type === 'BREAK' || current.type === 'LUNCH')) {
      throw new ConflictError(
        "You're on a break. End it before skipping another.",
        'ALREADY_ON_BREAK',
      );
    }

    // 4.0: nobody reviews an Admin's or a Super Admin's breaks (NOT_REQUIRED).
    const reviewed = person.role !== 'SUPER_ADMIN' && person.role !== 'ADMIN';
    const reason = cleanReason(dto.reason);
    if (reviewed && (reason?.length ?? 0) < shift.reasonMinChars) {
      throw new UnprocessableError(
        `Say why you are skipping the ${lower(dto.kind)} (at least ${shift.reasonMinChars} characters).`,
        'REASON_REQUIRED',
      ).withDetails({ minChars: shift.reasonMinChars });
    }

    const judged = classifyStart(slot, now, shift);
    const route = BreakApprovalPolicy.route(person);
    const result = await this.skips.createSkip(
      {
        ...this.baseRecord(person.id, day, shift, slot),
        startedAt: now,
        timing: judged.timing,
        minutesOff: judged.minutesOff,
        reason,
        source: 'AGENT',
        outcome: 'SKIPPED',
        approvalStatus: route.status,
        approverRole: route.approverRole,
        approverId: route.approverId,
      },
      generation,
      now,
      today,
    );
    if (!result.ok) {
      switch (result.code) {
        case 'BREAK_ALREADY_TAKEN':
          throw new ConflictError(
            `Your ${lower(dto.kind)} already has a record today.`,
            'BREAK_ALREADY_TAKEN',
          );
        case 'ALREADY_ON_BREAK':
          throw new ConflictError(
            "You're on a break. End it before skipping another.",
            'ALREADY_ON_BREAK',
          );
        default:
          throw dayClosedError(result.code);
      }
    }
    if (result.record.approvalStatus === 'PENDING') {
      const copy = skipRequestedCopy({ name: personName(person), kind: dto.kind, reason });
      await this.notify(result.record, NOTICE.SKIP_REQUESTED, copy.title, copy.body);
    }
    return { record: ShiftMapper.recordView(result.record, now) };
  }

  // ---- Comments --------------------------------------------------------------------

  /** The one comment a reason-less skip takes (POST /breaks/:id/comment). */
  async comment(
    me: AuthenticatedUser,
    id: string,
    comment: string,
    now: Date,
  ): Promise<{ record: BreakRecordView }> {
    const record = await this.records.findById(id);
    // Someone else's break reads as unknown, so ids cannot be probed (4.0 audit L2).
    if (!record || record.userId !== me.id) throw new NotFoundError('Unknown break');
    if (!isSkipRecord(record) || record.reason) {
      throw new ConflictError(
        isSkipRecord(record)
          ? 'This skip already has a reason.'
          : 'Only a skipped break takes a comment.',
        'COMMENT_NOT_NEEDED',
      );
    }
    const minChars = minCharsFor(record, await this.shiftMap());
    const text = cleanReason(comment);
    if ((text?.length ?? 0) < minChars) {
      throw new UnprocessableError(
        `Add a comment of at least ${minChars} characters.`,
        'REASON_REQUIRED',
      ).withDetails({ minChars });
    }
    const updated = await this.records.addComment(id, text as string, now);
    if (!updated) throw new ConflictError('This skip already has a reason.', 'COMMENT_NOT_NEEDED');
    await this.commented(updated, me.id);
    return { record: ShiftMapper.recordView(updated, now) };
  }

  /**
   * End Day's comments: every one is checked first and any problem fails the
   * whole call (422 COMMENT_INVALID, details.breakId). A record that already has
   * a reason is left alone (a retry after a refused End Day is harmless).
   */
  async saveEndDayComments(
    me: AuthenticatedUser,
    comments: { breakId: string; comment: string }[],
    now: Date,
  ): Promise<number> {
    return this.writeEndDayComments(me, await this.checkEndDayComments(me, comments), now);
  }

  /**
   * End Day comments judged without writing anything (422 COMMENT_INVALID on the
   * first bad one): for the caller's own skips, and for the auto-skips this End
   * Day is about to create (`planned`, by the ids they will get).
   */
  async checkEndDayComments(
    me: AuthenticatedUser,
    comments: { breakId: string; comment: string }[],
    planned: PlannedAutoSkip[] = [],
  ): Promise<CheckedComment[]> {
    if (!comments.length) return [];
    const shifts = await this.shiftMap();
    const plannedById = new Map(planned.map((p) => [p.record.id, p.record]));
    const seen = new Set<string>();
    const out: CheckedComment[] = [];
    for (const c of comments) {
      const problem = (p: CommentProblem, minChars?: number) =>
        new UnprocessableError(
          p === 'TOO_SHORT'
            ? `Each comment needs at least ${minChars} characters.`
            : p === 'TOO_LONG'
              ? `A comment can be at most ${REASON_MAX_CHARS} characters.`
              : 'One of the comments is for a break that cannot take it.',
          'COMMENT_INVALID',
        ).withDetails({ breakId: c.breakId, problem: p, ...(minChars ? { minChars } : {}) });
      if (seen.has(c.breakId)) throw problem('DUPLICATE');
      seen.add(c.breakId);
      const record: Pick<BreakRecordRow, 'id' | 'shiftId' | 'reason'> | null =
        plannedById.get(c.breakId) ?? (await this.records.findById(c.breakId));
      // Someone else's break reads as unknown, so ids cannot be probed.
      if (!record || (!plannedById.has(c.breakId) && (record as BreakRecordRow).userId !== me.id))
        throw problem('NOT_FOUND');
      if (!plannedById.has(c.breakId) && !isSkipRecord(record as BreakRecordRow))
        throw problem('NOT_A_SKIP');
      if (record.reason) continue;
      const minChars = minCharsFor(record, shifts);
      const text = cleanReason(c.comment) ?? '';
      if (text.length < minChars) throw problem('TOO_SHORT', minChars);
      if (text.length > REASON_MAX_CHARS) throw problem('TOO_LONG');
      out.push({ id: record.id, text });
    }
    return out;
  }

  /** Writes comments checked by checkEndDayComments (their records exist by now). */
  async writeEndDayComments(
    me: AuthenticatedUser,
    checked: CheckedComment[],
    now: Date,
  ): Promise<number> {
    let saved = 0;
    for (const s of checked) {
      const updated = await this.records.addComment(s.id, s.text, now);
      if (!updated) continue;
      saved += 1;
      await this.commented(updated, me.id);
    }
    return saved;
  }

  /**
   * The planned auto-skips that will wait for a manager, as the End Day comment
   * gate lists them (the ids they will be created with).
   */
  async plannedNeedingComment(planned: PlannedAutoSkip[]): Promise<SkipNeedingComment[]> {
    const pending = planned.filter((p) => p.record.approvalStatus === 'PENDING');
    if (!pending.length) return [];
    const shifts = await this.shiftMap();
    return pending.map(({ record }) => ({
      id: record.id,
      date: record.date,
      kind: record.kind as BreakKind,
      label: BREAK_LABEL[record.kind as BreakKind],
      outcome: 'AUTO_SKIPPED' as const,
      skippedAt: record.startedAt.toISOString(),
      scheduledStart: record.scheduledStart?.toISOString() ?? null,
      durationMin: record.durationMin,
      minChars: minCharsFor(record, shifts),
    }));
  }

  // ---- Auto-skip ------------------------------------------------------------------

  /**
   * One person's owed breaks with no record: closed windows become AUTO_SKIPPED
   * at their close; with `endingDay`, open windows at now (SPEC 1.4).
   */
  async autoSkipFor(userId: string, now: Date, endingDay: boolean): Promise<number> {
    return this.createPlanned(await this.planAutoSkipsFor(userId, now, endingDay), now);
  }

  /**
   * What autoSkipFor would create now, without writing anything (End Day judges
   * its gates first, so a refused End Day leaves no record and sends no notice).
   * Each planned record carries the id it will be created with.
   */
  async planAutoSkipsFor(
    userId: string,
    now: Date,
    endingDay: boolean,
  ): Promise<PlannedAutoSkip[]> {
    const person = await this.people.findById(userId);
    if (!person || !person.active) return [];
    const ctx = await this.days.context([userId]);
    return this.planPeople([person], ctx, now, endingDay);
  }

  /** The 5-minute job: everyone with a session today or yesterday (night shifts), or still open. */
  async autoSkipAll(now: Date): Promise<number> {
    const today = dateKeyInZone(now, appTimezone());
    const ids = await this.sessionsRepo.listUserIdsActiveOn([addDaysToKey(today, -1), today]);
    if (!ids.length) return 0;
    const people = (await this.people.findAnyByIds(ids)).filter((p) => p.active);
    if (!people.length) return 0;
    const ctx = await this.days.context(people.map((p) => p.id));
    return this.createPlanned(await this.planPeople(people, ctx, now, false), now);
  }

  private async planPeople(
    people: ShiftPerson[],
    ctx: Awaited<ReturnType<BreakDayService['context']>>,
    now: Date,
    endingDay: boolean,
  ): Promise<PlannedAutoSkip[]> {
    const days = people
      .map((p) => ({ person: p, day: this.days.dayWith(ctx, p, now) }))
      .filter(({ day }) => day.slots.length > 0);
    if (!days.length) return [];

    // One query per table: the records of each shift-day, the sessions around them.
    const byDate = new Map<string, string[]>();
    for (const { person, day } of days)
      byDate.set(day.dateKey, [...(byDate.get(day.dateKey) ?? []), person.id]);
    const recorded = new Map<string, Set<BreakKind>>();
    for (const [date, ids] of byDate) {
      for (const r of await this.records.listForUsersOnDate(ids, date)) {
        if (!isScheduledKind(r.kind)) continue;
        const k = `${r.userId}|${r.date}`;
        recorded.set(k, (recorded.get(k) ?? new Set<BreakKind>()).add(r.kind));
      }
    }
    const earliest = new Date(
      Math.min(...days.flatMap(({ day }) => day.slots.map((s) => s.windowOpen.getTime()))),
    );
    const sessions = await this.sessionsRepo.listOverlapping(
      days.map(({ person }) => person.id),
      earliest,
      now,
    );
    const managerIds = [
      ...new Set(days.map(({ person }) => person.managerId).filter((x): x is string => !!x)),
    ];
    const managers = new Map((await this.people.findAnyByIds(managerIds)).map((p) => [p.id, p]));

    const toCreate: PlannedAutoSkip[] = [];
    for (const { person, day } of days) {
      const shift = day.resolved.shift as ShiftRecord;
      const plans = planAutoSkips(
        day.slots,
        recorded.get(`${person.id}|${day.dateKey}`) ?? new Set(),
        sessions.filter((s) => s.userId === person.id),
        now,
        endingDay,
      );
      if (!plans.length) continue;
      const route = BreakApprovalPolicy.route(
        person,
        person.managerId ? (managers.get(person.managerId) ?? null) : null,
      );
      for (const plan of plans) {
        const slot = day.slots.find((s) => s.kind === plan.kind) as BreakSlot;
        toCreate.push({
          person,
          slot,
          record: {
            id: autoSkipId(person.id, day.dateKey, slot.kind),
            ...this.baseRecord(person.id, day, shift, slot),
            startedAt: plan.startedAt,
            timing: 'OUTSIDE_WINDOW',
            minutesOff: 0,
            reason: null,
            source: 'SYSTEM',
            outcome: 'AUTO_SKIPPED',
            approvalStatus: route.status,
            approverRole: route.approverRole,
            approverId: route.approverId,
          },
        });
      }
    }
    return toCreate;
  }

  /** Creates planned auto-skips and tells the approvers of the pending ones. */
  async createPlanned(toCreate: PlannedAutoSkip[], now: Date): Promise<number> {
    if (!toCreate.length) return 0;
    const created = await this.skips.createAutoSkips(
      toCreate.map((c) => c.record),
      now,
    );
    const tz = appTimezone();
    for (const r of created) {
      if (r.approvalStatus !== 'PENDING') continue;
      const who = toCreate.find((c) => c.person.id === r.userId)?.person;
      const copy = autoSkipRequestedCopy({
        name: who ? personName(who) : 'Someone',
        kind: r.kind,
        at: time12InZone(r.startedAt, tz),
      });
      await this.notify(r, NOTICE.AUTO_SKIP_REQUESTED, copy.title, copy.body);
    }
    if (created.length) this.logger.log(`auto-skipped ${created.length} owed break(s)`);
    return created.length;
  }

  // ---- Helpers ------------------------------------------------------------------------

  private baseRecord(userId: string, day: BreakDay, shift: ShiftRecord, slot: BreakSlot) {
    return {
      userId,
      date: day.dateKey,
      kind: slot.kind,
      presenceType: slot.presenceType,
      shiftId: shift.id,
      shiftName: shift.name,
      scheduledStart: slot.scheduledStart,
      durationMin: slot.durationMin,
      windowOpen: slot.windowOpen,
      windowClose: slot.windowClose,
      ringStart: slot.ringStart,
      ringEnd: slot.ringEnd,
    };
  }

  private async shiftMap(): Promise<Map<string, ShiftRecord>> {
    return new Map((await this.shifts.list()).map((s) => [s.id, s] as const));
  }

  private async commented(record: BreakRecordRow, byId: string): Promise<void> {
    const recipients =
      record.approvalStatus === 'PENDING'
        ? await this.breakEvents.recipientsFor(record)
        : record.decidedById && record.decidedById !== byId
          ? [record.decidedById]
          : [];
    if (!recipients.length) return;
    const person = await this.people.findById(record.userId);
    const copy = skipCommentCopy({
      name: person ? personName(person) : 'Someone',
      kind: record.kind,
      date: record.date,
      comment: record.reason ?? '',
    });
    await this.publish(recipients, NOTICE.SKIP_COMMENT_ADDED, copy.title, copy.body, record.userId);
  }

  private async notify(
    record: BreakRecordRow,
    type: string,
    title: string,
    body: string,
  ): Promise<void> {
    const recipients = await this.breakEvents.recipientsFor(record);
    await this.publish(recipients, type, title, body, record.userId);
  }

  private async publish(
    recipients: string[],
    type: string,
    title: string,
    body: string,
    fromUserId: string,
  ): Promise<void> {
    if (!recipients.length) return;
    try {
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(recipients, type, title, body, fromUserId),
      );
    } catch (err) {
      this.logger.warn(`${type} notice failed: ${(err as Error).message}`);
    }
  }
}
