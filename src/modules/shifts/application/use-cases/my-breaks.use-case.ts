import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError, UnprocessableError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { RequestClock } from '@shared/tenancy';
import { addDaysToKey, dateKeyInZone, time12InZone } from '@shared/utils/timezone';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
  BreakMoveResult,
  isReplaceableAutoSkip,
  takenSecOf,
  outcomeOf,
  Routing,
} from '../../domain/break-record.repository';
import { classifyStart, phaseAt } from '../../domain/break-schedule';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '../../domain/shift-people.reader';
import { SHIFT_REPOSITORY, ShiftRepository } from '../../domain/shift.repository';
import {
  BREAK_KINDS,
  BREAK_LABEL,
  BreakKind,
  DEFAULT_OVERRUN_GRACE_MIN,
  DEFAULT_REASON_MIN_CHARS,
  isScheduledKind,
  QUICK_BREAK_MINUTES,
} from '../../domain/shift.types';
import { BreakApprovalPolicy } from '../break-approval.policy';
import { BreakDay, BreakDayService } from '../break-day.service';
import { BreakEvents } from '../break-events.service';
import { EndBreakDto, StartBreakDto } from '../dto';
import { PresenceBridge } from '../presence-bridge.service';
import { ShiftMapper } from '../shift.mapper';
import {
  BreakRecordView,
  EndBreakResult,
  MyBreakDayView,
  MyBreakHistoryView,
  StartBreakResult,
} from '../shifts.types';

/** Longest history a person can pull in one call. */
export const MAX_HISTORY_DAYS = 31;

/** Trims a free-text reason; empty means none. */
export function cleanReason(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  return t.length ? t : null;
}

function lower(kind: BreakKind): string {
  return BREAK_LABEL[kind].toLowerCase();
}

/**
 * The staff side of scheduled breaks: what today looks like, starting a break
 * (with the reason rule), and ending it. Used by both agents and the portal.
 */
@Injectable()
export class MyBreaksUseCase {
  private readonly logger = new Logger(MyBreaksUseCase.name);

  constructor(
    @Inject(BREAK_RECORD_REPOSITORY) private readonly records: BreakRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepository,
    private readonly days: BreakDayService,
    private readonly presence: PresenceBridge,
    private readonly events: BreakEvents,
  ) {}

  private async person(id: string): Promise<ShiftPerson> {
    const p = await this.people.findById(id);
    if (!p) throw new NotFoundError('User not found');
    return p;
  }

  private async decidedByNames(rows: BreakRecordRow[]): Promise<Map<string, string>> {
    const ids = rows.map((r) => r.decidedById).filter((x): x is string => !!x);
    if (!ids.length) return new Map();
    const people = await this.people.findAnyByIds(ids);
    return new Map(people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
  }

  // ---- Today ------------------------------------------------------------------

  async today(me: AuthenticatedUser): Promise<MyBreakDayView> {
    const now = RequestClock.now();
    const person = await this.person(me.id);
    // A paused break whose window has closed ends at its pause (lazily, as the job does).
    await this.records.endExpiredPaused(now, person.id);
    const day = await this.days.dayFor(person, now);
    const [rows, open, paused, dayEnded] = await Promise.all([
      this.records.listForUserOnDate(person.id, day.dateKey),
      this.records.findOpenForUser(person.id),
      this.records.findPausedForUser(person.id),
      this.presence.dayEnded(person.id, dateKeyInZone(now, this.days.timezone)),
    ]);
    return this.dayView(day, rows, open, dayEnded, now, hasReviewer(person), paused);
  }

  /**
   * @param reviewed whether someone reviews this person's off-schedule breaks. A
   * Super Admin has nobody above them, so the rules they see ask for no reason
   * and no overrun note (the timing is still recorded).
   */
  private async dayView(
    day: BreakDay,
    rows: BreakRecordRow[],
    open: BreakRecordRow | null,
    dayEnded: boolean,
    now: Date,
    reviewed: boolean,
    paused: BreakRecordRow | null = null,
  ): Promise<MyBreakDayView> {
    const tz = this.days.timezone;
    let all = open && !rows.some((r) => r.id === open.id) ? [...rows, open] : rows;
    if (paused && !all.some((r) => r.id === paused.id)) all = [...all, paused];
    const names = await this.decidedByNames(all);
    const views = new Map<string, BreakRecordView>(
      all.map((r) => [r.id, ShiftMapper.recordView(r, now, names)]),
    );
    const byKind = new Map<BreakKind, BreakRecordView>();
    for (const r of rows) if (isScheduledKind(r.kind)) byKind.set(r.kind, views.get(r.id)!);

    const shift = day.resolved.shift;
    const scheduled = !!shift && day.workday && day.slots.length > 0;
    return {
      date: day.dateKey,
      serverNow: now.toISOString(),
      timezone: tz,
      mode: scheduled ? 'SCHEDULED' : 'FREE',
      workday: day.workday,
      dayEnded,
      shift: shift
        ? {
            ...ShiftMapper.ref(shift)!,
            rules: {
              ringLeadMin: shift.ringLeadMin,
              ringDurationMin: shift.ringDurationMin,
              ringSound: shift.ringSound,
              reasonOnEarly: reviewed && shift.reasonOnEarly,
              reasonOnLate: reviewed && shift.reasonOnLate,
              reasonMinChars: shift.reasonMinChars,
              overrunReason: reviewed && shift.overrunReason,
              overrunGraceMin: shift.overrunGraceMin,
            },
          }
        : null,
      source: day.resolved.source,
      breaks: day.slots.map((s) => ShiftMapper.slotView(s, tz, byKind.get(s.kind) ?? null)),
      unscheduled: rows.filter((r) => !r.kind).map((r) => views.get(r.id)!),
      activeBreak: open ? views.get(open.id)! : null,
      quick: rows.filter((r) => r.kind === 'QUICK').map((r) => views.get(r.id)!),
      pausedBreak: paused ? views.get(paused.id)! : null,
      active: open ? activeOf(open, now) : null,
      quickBreakMinutes: QUICK_BREAK_MINUTES,
    };
  }

  // ---- Start --------------------------------------------------------------------

  async start(me: AuthenticatedUser, dto: StartBreakDto): Promise<StartBreakResult> {
    const now = RequestClock.now();
    const tz = this.days.timezone;
    const person = await this.person(me.id);
    const day = await this.days.dayFor(person, now);
    const shift = day.resolved.shift;
    const slot = day.slots.find((s) => s.kind === dto.kind);
    const label = BREAK_LABEL[dto.kind];

    if (!shift || !slot) {
      throw new ConflictError(
        `No ${lower(dto.kind)} is scheduled for you today.`,
        'BREAK_NOT_SCHEDULED',
      );
    }

    const taken = (await this.records.listForUserOnDate(person.id, day.dateKey)).filter(
      // An auto-skip End Day made inside this still-open window, on a day that then
      // carried on, gives way to the real break (replaced in the same transaction).
      (r) =>
        !(
          r.kind === dto.kind &&
          isReplaceableAutoSkip(
            {
              outcome: outcomeOf(r),
              reason: r.reason,
              startedAt: r.startedAt,
              windowClose: r.windowClose,
            },
            now,
          )
        ),
    );
    if (taken.some((r) => r.kind === dto.kind)) {
      throw new ConflictError(
        `You've already taken your ${lower(dto.kind)} today.`,
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

    const phase = phaseAt(slot, now);
    if (phase === 'UPCOMING') {
      throw new ConflictError(
        `Your ${lower(dto.kind)} opens at ${time12InZone(slot.windowOpen, tz)}.`,
        'BREAK_NOT_OPEN',
      ).withDetails({ opensAt: slot.windowOpen.toISOString() });
    }
    if (phase === 'CLOSED') {
      throw new ConflictError(
        `The ${lower(dto.kind)} window closed at ${time12InZone(slot.windowClose, tz)}. It counts as skipped.`,
        'BREAK_WINDOW_CLOSED',
      ).withDetails({ closedAt: slot.windowClose.toISOString() });
    }

    const judged = classifyStart(slot, now, shift);
    // Nobody reviews a Super Admin's breaks, so there is no one to explain to.
    const reasonRequired = judged.reasonRequired && hasReviewer(person);
    const reason = cleanReason(dto.reason);
    if (reasonRequired && (reason?.length ?? 0) < shift.reasonMinChars) {
      const when = judged.timing === 'LATE' ? 'late' : 'early';
      throw new UnprocessableError(
        `You're starting the ${lower(dto.kind)} ${judged.minutesOff} min ${when}. ` +
          `Add a reason for your manager (at least ${shift.reasonMinChars} characters).`,
        'REASON_REQUIRED',
      ).withDetails({
        timing: judged.timing,
        minutesOff: judged.minutesOff,
        minChars: shift.reasonMinChars,
      });
    }

    const route = reasonRequired
      ? BreakApprovalPolicy.route(person)
      : { status: 'NOT_REQUIRED' as const, approverRole: null, approverId: null };

    // 4.0: a paused break ends (at its pause) when another scheduled break starts.
    await this.records.endPaused(person.id);

    const outcome = await this.records.startScheduled(
      {
        userId: person.id,
        date: day.dateKey,
        kind: dto.kind,
        presenceType: slot.presenceType,
        shiftId: shift.id,
        shiftName: shift.name,
        scheduledStart: slot.scheduledStart,
        durationMin: slot.durationMin,
        windowOpen: slot.windowOpen,
        windowClose: slot.windowClose,
        ringStart: slot.ringStart,
        ringEnd: slot.ringEnd,
        startedAt: now,
        timing: judged.timing,
        minutesOff: judged.minutesOff,
        reason,
        source: 'AGENT',
        approvalStatus: route.status,
        approverRole: route.approverRole,
        approverId: route.approverId,
      },
      { calendarDay: dateKeyInZone(now, tz) },
      now,
    );

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'DAY_ENDED':
          throw new ConflictError(
            'Your working day has already ended. Breaks resume tomorrow.',
            'DAY_ENDED',
          );
        case 'ALREADY_ON_BREAK':
          throw new ConflictError(
            "You're already on a break. End it before starting another.",
            'ALREADY_ON_BREAK',
          );
        default:
          throw new ConflictError(
            `You've already taken your ${lower(dto.kind)} today.`,
            'BREAK_ALREADY_TAKEN',
          );
      }
    }

    const opened = {
      id: outcome.presenceSessionId,
      userId: person.id,
      deviceId: null,
      type: slot.presenceType,
      note: null,
      date: dateKeyInZone(now, tz),
      startedAt: now,
      endedAt: null,
      durationSec: null,
    };
    void this.presence.broadcast(person.id, opened, now);
    if (outcome.record.approvalStatus === 'PENDING') {
      void this.events.approvalRequested(outcome.record, person, false);
    }
    this.logger.debug(
      `${person.id} started ${label} (${judged.timing}${judged.minutesOff ? ` ${judged.minutesOff}m` : ''})`,
    );

    return {
      record: ShiftMapper.recordView(outcome.record, now),
      presence: {
        status: slot.presenceType,
        sessionId: outcome.presenceSessionId,
        note: null,
        since: now.toISOString(),
        elapsedSec: 0,
      },
    };
  }

  // ---- 4.0: quick breaks, pause and resume (docs/4.0/SPEC.md 2.3) -----------------

  /** Refusals of the 4.0 break moves, in plain words. */
  private refuse(result: Extract<BreakMoveResult, { ok: false }>): never {
    switch (result.code) {
      case 'ON_BREAK':
        throw new ConflictError("You're already on a break. End it first.", 'ON_BREAK');
      case 'IN_MEETING':
        throw new ConflictError("You're in a meeting. End the meeting first.", 'IN_MEETING');
      case 'DAY_NOT_STARTED':
        throw new ConflictError('Start your day first.', 'DAY_NOT_STARTED');
      case 'DAY_ENDED':
        throw new ConflictError('Your working day has already ended.', 'DAY_ENDED');
      case 'NOT_ACTIVE':
        throw new ConflictError('That break is not running.', 'NOT_ACTIVE');
      case 'NOT_PAUSABLE':
        throw new ConflictError('A quick break cannot be paused. End it instead.', 'NOT_PAUSABLE');
      case 'NOT_PAUSED':
        throw new ConflictError('That break is not paused.', 'NOT_PAUSED');
      case 'RESUME_WINDOW_CLOSED': {
        const until = result.record?.windowClose;
        throw new ConflictError(
          until
            ? `The break window closed at ${time12InZone(until, this.days.timezone)}. The break has ended.`
            : 'The break window has closed. The break has ended.',
          'RESUME_WINDOW_CLOSED',
        );
      }
      default:
        throw new NotFoundError('Unknown break');
    }
  }

  /**
   * POST /breaks/quick/start: a quick break of 1..60 minutes (the agent offers 5,
   * 10, 15), any time the day is open and nothing else is running. No approval:
   * pay is decided by the allowance. `startedAt` back-dates an away break.
   */
  async startQuick(
    me: AuthenticatedUser,
    plannedMin: number,
    opts: { startedAt?: Date } = {},
  ): Promise<{ record: BreakRecordView; presence: StartBreakResult['presence'] }> {
    const now = RequestClock.now();
    if (!Number.isInteger(plannedMin) || plannedMin < 1 || plannedMin > 60) {
      throw new UnprocessableError('A quick break lasts 1 to 60 minutes.', 'VALIDATION_ERROR');
    }
    const person = await this.person(me.id);
    const startedAt = opts.startedAt ?? now;
    const day = await this.days.dayFor(person, startedAt);
    const shift = day.resolved.shift;
    const result = await this.records.startQuick(
      {
        userId: person.id,
        date: day.dateKey,
        plannedMin,
        startedAt,
        calendarDay: dateKeyInZone(startedAt, this.days.timezone),
        shiftId: shift?.id ?? null,
        shiftName: shift?.name ?? null,
      },
      now,
    );
    if (!result.ok) this.refuse(result);
    void this.presence.broadcast(
      person.id,
      {
        id: result.presenceSessionId!,
        userId: person.id,
        deviceId: null,
        type: 'BREAK',
        note: null,
        date: dateKeyInZone(startedAt, this.days.timezone),
        startedAt,
        endedAt: null,
        durationSec: null,
      },
      now,
    );
    return {
      record: ShiftMapper.recordView(result.record, now),
      presence: {
        status: 'BREAK',
        sessionId: result.presenceSessionId!,
        note: null,
        since: startedAt.toISOString(),
        elapsedSec: Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000)),
      },
    };
  }

  /** POST /breaks/:id/pause: back to work for now; the break can resume while its window is open. */
  async pause(me: AuthenticatedUser, id: string): Promise<BreakRecordView> {
    const now = RequestClock.now();
    const result = await this.records.pause(id, me.id, now);
    if (!result.ok) this.refuse(result);
    void this.presence.broadcast(me.id, null, now);
    return ShiftMapper.recordView(result.record, now);
  }

  /** POST /breaks/:id/resume: a new segment of a paused break, while its window is open. */
  async resume(me: AuthenticatedUser, id: string): Promise<BreakRecordView> {
    const now = RequestClock.now();
    const calendarDay = dateKeyInZone(now, this.days.timezone);
    const result = await this.records.resume(id, me.id, now, calendarDay);
    if (!result.ok) this.refuse(result);
    void this.presence.broadcast(
      me.id,
      {
        id: result.presenceSessionId!,
        userId: me.id,
        deviceId: null,
        type: result.record.presenceType,
        note: null,
        date: calendarDay,
        startedAt: now,
        endedAt: null,
        durationSec: null,
      },
      now,
    );
    return ShiftMapper.recordView(result.record, now);
  }

  // ---- End --------------------------------------------------------------------

  /**
   * Back to work (SPEC 1.5). Back later than the shift's grace allows:
   *  - askToCount true: needs an overrun reason of reasonMinChars (else 422
   *    REASON_REQUIRED and the break keeps running); the record asks for the
   *    minutes to count and goes PENDING (a decided one is reopened);
   *  - askToCount false, or nothing sent: the minutes stay out, no approval;
   *  - agents before 3.1 send only overrunReason: a non-empty one is an ask, and
   *    is never refused (those agents treat ending a break as never refused).
   * overrunSec is always stored. A Super Admin is never asked for anything.
   * Idempotent: a retry after the break already ended returns ended=false.
   */
  async end(
    me: AuthenticatedUser,
    dto: EndBreakDto,
    opts: { agent40?: boolean } = {},
  ): Promise<EndBreakResult> {
    const now = RequestClock.now();
    const open = await this.records.findOpenForUser(me.id);

    if (!open) {
      // 4.0: a paused break ends at its pause.
      const paused = await this.records.findPausedForUser(me.id);
      if (paused) {
        const ended = await this.records.markEnded(paused.id, now);
        return { ended: true, record: ended ? ShiftMapper.recordView(ended, now) : null };
      }
      // A plain break or lunch from the older flow still ends here, so the
      // agent's "back to work" always works.
      const session = await this.presence.findOpen(me.id);
      if (session && (session.type === 'BREAK' || session.type === 'LUNCH')) {
        await this.presence.endOpen(me.id, now);
        void this.presence.broadcast(me.id, null, now);
        return { ended: true, record: null };
      }
      return { ended: false, record: null };
    }

    // Over its length: the taken time over all segments (4.0), not start to now.
    const takenSec = takenSecOf(open, now);
    const overrunSec =
      open.kind === 'QUICK' || !open.durationMin
        ? 0
        : Math.max(0, takenSec - open.durationMin * 60);

    // 4.0 agents and quick breaks: no overrun ask (the paid buffer covers overruns).
    if (opts.agent40 || open.kind === 'QUICK') {
      await this.presence.endOpen(me.id, now);
      void this.presence.broadcast(me.id, null, now);
      await this.records.finishBreak(open.id, { overrunSec, ask: null }, now);
      const ended = await this.records.markEnded(open.id, now);
      const names = ended ? await this.decidedByNames([ended]) : new Map<string, string>();
      return { ended: true, record: ended ? ShiftMapper.recordView(ended, now, names) : null };
    }

    const reason = cleanReason(dto.overrunReason);
    const shift = open.shiftId ? await this.shifts.findById(open.shiftId) : null;
    const graceSec = (shift?.overrunGraceMin ?? DEFAULT_OVERRUN_GRACE_MIN) * 60;
    const minChars = shift?.reasonMinChars ?? DEFAULT_REASON_MIN_CHARS;
    const reviewed = me.role !== Role.SUPER_ADMIN && me.role !== Role.ADMIN;
    const overGrace = overrunSec > graceSec;
    const asks = overGrace && (dto.askToCount ?? !!reason);

    if (asks && dto.askToCount === true && reviewed && (reason?.length ?? 0) < minChars) {
      const overMin = Math.max(1, Math.round(overrunSec / 60));
      throw new UnprocessableError(
        `Say why you were back ${overMin} min late (at least ${minChars} characters), ` +
          'or leave the minutes out.',
        'REASON_REQUIRED',
      ).withDetails({ minChars, overrunSec });
    }

    await this.presence.endOpen(me.id, now);
    void this.presence.broadcast(me.id, null, now);

    let subject: ShiftPerson | null = null;
    let routing: Routing | null = null;
    if (asks && reviewed) {
      subject = await this.people.findById(me.id);
      if (subject) {
        const r = BreakApprovalPolicy.route(subject);
        routing =
          r.status === 'PENDING'
            ? { approverRole: r.approverRole, approverId: r.approverId }
            : null;
      }
    }

    const finished = await this.records.finishBreak(
      open.id,
      { overrunSec, ask: asks ? { reason, routing } : null },
      now,
    );
    if (!finished) return { ended: true, record: null };
    if (finished.becamePending && subject) {
      void this.events.approvalRequested(finished.row, subject, true);
    }
    const row = (await this.records.markEnded(open.id, now)) ?? finished.row;
    const names = await this.decidedByNames([row]);
    return { ended: true, record: ShiftMapper.recordView(row, now, names) };
  }

  // ---- History ----------------------------------------------------------------

  async history(me: AuthenticatedUser, days = 14): Promise<MyBreakHistoryView> {
    const now = RequestClock.now();
    const span = Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.floor(days)));
    const to = dateKeyInZone(now, this.days.timezone);
    const from = addDaysToKey(to, -(span - 1));
    const rows = await this.records.listForUserBetween(me.id, from, to);
    const names = await this.decidedByNames(rows);
    return { from, to, items: rows.map((r) => ShiftMapper.recordView(r, now, names)) };
  }
}

/** Whether anyone reviews this person's off-schedule breaks (4.0: not Admins or Super Admins). */
function hasReviewer(person: Pick<ShiftPerson, 'role'>): boolean {
  return person.role !== 'SUPER_ADMIN' && person.role !== 'ADMIN';
}

/** The running break in the compact form the agent's timer uses (4.0). */
function activeOf(r: BreakRecordRow, now: Date): MyBreakDayView['active'] {
  const segs = r.segments ?? [];
  const running = segs.find((g) => g.endedAt === null);
  const before = segs
    .filter((g) => g !== running && g.endedAt)
    .reduce((sum, g) => sum + Math.max(0, g.endedAt!.getTime() - g.startedAt.getTime()), 0);
  void now;
  return {
    id: r.id,
    kind: r.kind,
    segmentStartedAt: (running?.startedAt ?? r.startedAt).toISOString(),
    takenBeforeSec: Math.floor(before / 1000),
    plannedMin: r.plannedMin ?? null,
    durationMin: r.durationMin,
  };
}
