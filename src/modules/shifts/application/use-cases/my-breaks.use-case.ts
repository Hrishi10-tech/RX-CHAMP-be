import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError, UnprocessableError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { addDaysToKey, dateKeyInZone, hmInZone } from '@shared/utils/timezone';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
  isReplaceableAutoSkip,
  outcomeOf,
  Routing,
} from '../../domain/break-record.repository';
import { classifyStart, overrunSeconds, phaseAt } from '../../domain/break-schedule';
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
    const now = new Date();
    const person = await this.person(me.id);
    const day = await this.days.dayFor(person, now);
    const [rows, open, dayEnded] = await Promise.all([
      this.records.listForUserOnDate(person.id, day.dateKey),
      this.records.findOpenForUser(person.id),
      this.presence.dayEnded(person.id, dateKeyInZone(now, this.days.timezone)),
    ]);
    return this.dayView(day, rows, open, dayEnded, now, hasReviewer(person));
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
  ): Promise<MyBreakDayView> {
    const tz = this.days.timezone;
    const all = open && !rows.some((r) => r.id === open.id) ? [...rows, open] : rows;
    const names = await this.decidedByNames(all);
    const views = new Map<string, BreakRecordView>(
      all.map((r) => [r.id, ShiftMapper.recordView(r, now, names)]),
    );
    const byKind = new Map<BreakKind, BreakRecordView>();
    for (const r of rows) if (r.kind) byKind.set(r.kind, views.get(r.id)!);

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
    };
  }

  // ---- Start --------------------------------------------------------------------

  async start(me: AuthenticatedUser, dto: StartBreakDto): Promise<StartBreakResult> {
    const now = new Date();
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
    const later = taken.find((r) => r.kind && BREAK_KINDS.indexOf(r.kind) > order);
    if (later?.kind) {
      throw new ConflictError(
        `You've already taken your ${lower(later.kind)}, so the ${lower(dto.kind)} is no longer available.`,
        'BREAK_ORDER',
      );
    }

    const phase = phaseAt(slot, now);
    if (phase === 'UPCOMING') {
      throw new ConflictError(
        `Your ${lower(dto.kind)} opens at ${hmInZone(slot.windowOpen, tz)}.`,
        'BREAK_NOT_OPEN',
      ).withDetails({ opensAt: slot.windowOpen.toISOString() });
    }
    if (phase === 'CLOSED') {
      throw new ConflictError(
        `The ${lower(dto.kind)} window closed at ${hmInZone(slot.windowClose, tz)}. It counts as skipped.`,
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
      ? BreakApprovalPolicy.route(person, await this.managerOf(person))
      : { status: 'NOT_REQUIRED' as const, approverRole: null, approverId: null };

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

  private async managerOf(person: ShiftPerson): Promise<ShiftPerson | null> {
    return person.managerId ? this.people.findById(person.managerId) : null;
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
  async end(me: AuthenticatedUser, dto: EndBreakDto): Promise<EndBreakResult> {
    const now = new Date();
    const open = await this.records.findOpenForUser(me.id);

    if (!open) {
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

    const overrunSec = overrunSeconds(open.durationMin, open.startedAt, now, now);
    const reason = cleanReason(dto.overrunReason);
    const shift = open.shiftId ? await this.shifts.findById(open.shiftId) : null;
    const graceSec = (shift?.overrunGraceMin ?? DEFAULT_OVERRUN_GRACE_MIN) * 60;
    const minChars = shift?.reasonMinChars ?? DEFAULT_REASON_MIN_CHARS;
    const reviewed = me.role !== Role.SUPER_ADMIN;
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
        const r = BreakApprovalPolicy.route(subject, await this.managerOf(subject));
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
    const names = await this.decidedByNames([finished.row]);
    return { ended: true, record: ShiftMapper.recordView(finished.row, now, names) };
  }

  // ---- History ----------------------------------------------------------------

  async history(me: AuthenticatedUser, days = 14): Promise<MyBreakHistoryView> {
    const now = new Date();
    const span = Math.min(MAX_HISTORY_DAYS, Math.max(1, Math.floor(days)));
    const to = dateKeyInZone(now, this.days.timezone);
    const from = addDaysToKey(to, -(span - 1));
    const rows = await this.records.listForUserBetween(me.id, from, to);
    const names = await this.decidedByNames(rows);
    return { from, to, items: rows.map((r) => ShiftMapper.recordView(r, now, names)) };
  }
}

/** Whether anyone reviews this person's off-schedule breaks (everyone but a Super Admin). */
function hasReviewer(person: Pick<ShiftPerson, 'role'>): boolean {
  return person.role !== 'SUPER_ADMIN';
}
