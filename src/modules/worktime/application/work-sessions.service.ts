import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { API_COPY } from '@shared/copy/api-copy';
import { ConflictError } from '@shared/exceptions/app.exception';
import { attendanceByBiometric } from '@shared/exceptions/attendance-by-biometric';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { RequestClock } from '@shared/tenancy';
import { NoticeEvent } from '@shared/events/notice.event';
import { appTimezone, dateKeyInZone, time12InZone } from '@shared/utils/timezone';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService, ResolutionContext } from '@modules/shifts/application/break-day.service';
import { personName } from '@modules/shifts/application/break-events.service';
import { ShiftDayResolver } from '@modules/shifts/application/shift-day.resolver';
import { ShiftPickService } from '@modules/shifts/application/shift-pick.service';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
} from '@modules/shifts/domain/break-record.repository';
import { AgentGeneration } from '../domain/agent-generation';
import {
  autoCloseAt,
  idleCloseDue,
  idleRuleFrom,
  isStale,
  lastInputWithMeeting,
  latestEndOf,
} from '../domain/auto-close';
import { START_DAY_BACKDATE_MS } from '../domain/meetings';
import {
  AutoCloseMeeting,
  dayAutoClosedManagerCopy,
  dayAutoClosedSelfCopy,
  NOTICE,
} from '../domain/notice-copy';
import { WFH_NOTICE, wfhAutoEndedCopy } from '@modules/wfh/domain/wfh-copy';
import {
  EndDayTxResult,
  LAST_ENDED_WITHIN_MS,
  StartDayTxResult,
  WORK_SESSION_REPOSITORY,
  WorkSessionRecord,
  WorkSessionRepository,
} from '../domain/work-session.repository';

/** How long a computed latestEnd is reused for the lazy check (shift edits are rare). */
const LATEST_END_TTL_MS = 5 * 60_000;
const LATEST_END_CACHE_MAX = 5_000;

/**
 * Work sessions (SPEC 1.1, 1.2): Start Day, End Day, the implicit session of
 * agents older than 3.1, the open-day check for actions, and the missed End Day
 * auto-close (a 10-minute job, and lazily before a person's day is read).
 */
@Injectable()
export class WorkSessionsService {
  private readonly logger = new Logger(WorkSessionsService.name);
  private readonly latestEndCache = new Map<string, { latestEnd: number; at: number }>();

  constructor(
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly breakRecords: BreakRecordRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly days: BreakDayService,
    private readonly settings: AppSettingsService,
    private readonly dayKeys: ShiftDayResolver,
    @Optional() private readonly shiftPick?: ShiftPickService,
  ) {}

  get timezone(): string {
    return appTimezone();
  }

  /** 4.1: the person's department shares one computer between shifts. */
  sharedComputerFor(userId: string): Promise<boolean> {
    return this.settings.sharedComputerFor(userId);
  }

  /**
   * The person's working day at `now`: their shift-day (00:30 on an 18:30 to
   * 03:30 shift belongs to the evening before), else the calendar day.
   */
  todayFor(userId: string, now: Date): Promise<string> {
    return this.dayKeys.dayKeyAt(userId, now);
  }

  findOpen(userId: string): Promise<WorkSessionRecord | null> {
    return this.sessions.findOpen(userId);
  }

  findLastEnded(userId: string): Promise<WorkSessionRecord | null> {
    return this.sessions.findLastEnded(userId);
  }

  /** Whether one of the person's work sessions (open or closed) covers the instant `at`. */
  async workedAt(userId: string, at: Date): Promise<boolean> {
    const t = at.getTime();
    return (await this.sessions.listOverlapping([userId], at, at)).some(
      (s) => s.startedAt.getTime() <= t && (s.endedAt === null || s.endedAt.getTime() > t),
    );
  }

  /**
   * An input (a non-idle activity sample) that arrives late, from an offline
   * backlog, taken after the server auto-closed the person's day at the last input
   * it knew of but before that day's latest end: the day was worked until then, so
   * the automatic close moves to it (the auto-close rule, with the input that has
   * arrived since) and the session becomes a REPLAY one, so it counts only where
   * the samples cover it. Only a 4.x agent's samples get here (ReportActivityFlow).
   * True when the day now runs to `at`.
   */
  async extendAutoClosed(userId: string, at: Date): Promise<boolean> {
    const s = await this.sessions.lastStartedAtOrBefore(userId, at);
    if (!s?.endedAt || s.endReason !== 'AUTO_CLOSED') return false;
    const t = at.getTime();
    if (t < s.endedAt.getTime()) return false;
    const latestEnd = await this.latestEndOfSession(s);
    if (t > latestEnd.getTime()) return false;
    if (t === s.endedAt.getTime()) return true;
    const moved = await this.sessions.extendAutoClosed(s, at);
    if (moved) this.latestEndCache.delete(s.id);
    return moved;
  }

  /**
   * The latest end of one session's working day (ReplayDayLimits): no automatic
   * close, nor a move of one, nor a replayed reopen, ever goes past it.
   */
  async latestEndOfSession(
    s: Pick<WorkSessionRecord, 'userId' | 'date' | 'startedAt' | 'extendedAt'>,
  ): Promise<Date> {
    const [people, ctx] = await Promise.all([
      this.people.findAnyByIds([s.userId]),
      this.days.context([s.userId]),
    ]);
    const person = people[0] ?? null;
    const settings = await this.settings.get(person?.companyId ?? null);
    return this.latestEndFor(s, person, ctx, settings.autoCloseAfterShiftEndMin);
  }

  // ---- Start / End Day ----------------------------------------------------------

  /**
   * 409 ATTENDANCE_BY_BIOMETRIC for someone whose day comes from the biometric
   * device (3.5): the desktop agent can neither start nor end it.
   */
  async assertAgentDay(userId: string, action: 'start' | 'end' | 'act'): Promise<void> {
    const person = await this.people.findById(userId);
    if (person?.attendanceSource !== 'BIOMETRIC') return;
    throw attendanceByBiometric(action);
  }

  async startDay(
    userId: string,
    startedAt: Date,
    generation: AgentGeneration,
    now: Date,
  ): Promise<StartDayTxResult> {
    await this.assertAgentDay(userId, 'start');
    await this.autoCloseIfStale(userId, now);
    await this.pickShift(userId, startedAt);
    const dayOf = await this.dayKeys.keyFnFor(userId);
    return this.sessions.startDay(
      userId,
      startedAt,
      now,
      RequestClock.isReplay() ? 'REPLAY' : generation === 'AGENT_31' ? 'AGENT' : 'LEGACY',
      dayOf,
    );
  }

  /**
   * 4.1: a department running several shifts gives the person the one that is on
   * (first Start Day of the day only). Never blocks Start Day.
   */
  private async pickShift(userId: string, startedAt: Date): Promise<void> {
    try {
      await this.shiftPick?.pickOnStartDay(userId, startedAt);
    } catch (err) {
      this.logger.warn(`could not pick a shift for ${userId}: ${String(err)}`);
    }
  }

  async endDay(userId: string, generation: AgentGeneration, now: Date): Promise<EndDayTxResult> {
    // 4.0: a paused break ends at its pause before the day closes.
    await this.breakRecords.endPaused(userId);
    await this.assertAgentDay(userId, 'end');
    const today = await this.todayFor(userId, now);
    return this.sessions.endDay(
      userId,
      now,
      today,
      generation === 'LEGACY',
      new Date(now.getTime() - LAST_ENDED_WITHIN_MS),
    );
  }

  /**
   * The day must be open for an action (a break start, a meeting). A legacy
   * caller gets an implicit session; a 3.1 agent 409 DAY_NOT_STARTED / DAY_ENDED.
   */
  async ensureOpen(
    userId: string,
    generation: AgentGeneration,
    now: Date,
  ): Promise<WorkSessionRecord> {
    await this.assertAgentDay(userId, 'act');
    await this.autoCloseIfStale(userId, now);
    const today = await this.todayFor(userId, now);
    const result = await this.sessions.ensureOpen(userId, generation, now, today);
    if (!result.ok) throw dayClosedError(result.code);
    return result.session;
  }

  /**
   * An older agent's first active sample of the working day opens it (source
   * LEGACY): at the PC sign-in the agent already reported for this working day
   * (work_day_ends.login_at; so a day begun before the 3.1 deploy keeps its
   * morning), else at the sample, trusted at most 10 minutes back.
   */
  async openImplicitForSample(
    userId: string,
    at: Date,
    now: Date,
  ): Promise<WorkSessionRecord | null> {
    // A biometric person's day comes from the device only (3.5).
    if ((await this.people.findById(userId))?.attendanceSource === 'BIOMETRIC') return null;
    const dayOf = await this.dayKeys.keyFnFor(userId);
    const today = dayOf(now);
    if (dayOf(at) !== today) return null;
    const calendar = dateKeyInZone(now, this.timezone);
    const logins = (await this.sessions.loginTimes(userId, [today, calendar]))
      .filter((t) => t.getTime() <= now.getTime() && dayOf(t) === today)
      .sort((a, b) => a.getTime() - b.getTime());
    const start =
      logins[0] ?? new Date(Math.max(at.getTime(), now.getTime() - START_DAY_BACKDATE_MS));
    return this.sessions.openImplicit(userId, start, today);
  }

  // ---- Auto-close ------------------------------------------------------------------

  /** Lazy check before reading one person's day. True when it closed something. */
  async autoCloseIfStale(userId: string, now: Date): Promise<boolean> {
    const open = await this.sessions.findOpen(userId);
    if (!open) return false;
    // A biometric day is closed by the biometric module from its punches (3.5).
    if (open.source === 'BIOMETRIC') return false;
    // The cache holds the earliest instant this session could be closed (the idle
    // rule's due time, or the hard stop): nothing to check before it.
    const cached = this.latestEndCache.get(open.id);
    if (
      cached &&
      now.getTime() - cached.at < LATEST_END_TTL_MS &&
      now.getTime() < cached.latestEnd
    ) {
      return false;
    }
    const closed = await this.closeStale([open], now);
    return closed > 0;
  }

  /** The 10-minute job: every open session. Returns how many were closed. */
  async autoCloseAll(now: Date): Promise<number> {
    const open = await this.sessions.listOpen();
    if (!open.length) return 0;
    return this.closeStale(open, now);
  }

  private async closeStale(open: WorkSessionRecord[], now: Date): Promise<number> {
    const userIds = [...new Set(open.map((s) => s.userId))];
    const [people, ctx] = await Promise.all([
      this.people.findAnyByIds(userIds),
      this.days.context(userIds),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    // 4.0: settings are per organisation (docs/4.0/SPEC.md 1.4).
    const orgs = [...new Set(open.map((s) => byId.get(s.userId)?.companyId ?? null))];
    const settingsByOrg = new Map(
      await Promise.all(orgs.map(async (o) => [o, await this.settings.get(o)] as const)),
    );
    const stale: { session: WorkSessionRecord; latestEnd: Date }[] = [];
    // Work from home on the phone (3.5): no keyboard or mouse to read, so a day left
    // running is ended at the shift end once the latest close has passed.
    const wfhStale: { session: WorkSessionRecord; closeAt: Date }[] = [];
    // 3.2 Forgotten End Day: past the shift's end, a day nobody has touched the
    // keyboard or mouse in for `forgottenEndDayIdleMin` is ended. Needs the last
    // input, read in one query.
    const watch: {
      session: WorkSessionRecord;
      latestEnd: Date;
      basis: { startedAt: Date; shiftEnd: Date | null };
      idleMin: number;
    }[] = [];
    for (const s of open) {
      // A biometric day is closed by its punches (the biometric module, 3.5).
      if (s.source === 'BIOMETRIC') continue;
      const person = byId.get(s.userId) ?? null;
      const settings = settingsByOrg.get(person?.companyId ?? null)!;
      const latestEnd = this.latestEndFor(s, person, ctx, settings.autoCloseAfterShiftEndMin);
      if (s.source === 'MOBILE_WFH') {
        const shiftEnd = this.shiftEndFor(s, person, ctx);
        if (isStale(latestEnd, now)) {
          const closeAt =
            shiftEnd && shiftEnd.getTime() > s.startedAt.getTime() ? shiftEnd : latestEnd;
          wfhStale.push({ session: s, closeAt });
        } else {
          this.remember(s.id, latestEnd, now);
        }
        continue;
      }
      // 4.1 shared computer: a day carried on into the next shift is measured from
      // that answer, as a day with no shift, never from the first shift's end.
      const basis = s.extendedAt
        ? { startedAt: s.extendedAt, shiftEnd: null }
        : { startedAt: s.startedAt, shiftEnd: this.shiftEndFor(s, person, ctx) };
      const idleFrom = idleRuleFrom(basis);
      if (isStale(latestEnd, now)) stale.push({ session: s, latestEnd });
      else if (now.getTime() >= idleFrom.getTime()) {
        watch.push({ session: s, latestEnd, basis, idleMin: settings.forgottenEndDayIdleMin });
      }
      // The lazy check needs nothing before the idle rule can apply.
      this.remember(s.id, new Date(Math.min(latestEnd.getTime(), idleFrom.getTime())), now);
    }
    let closedWfh = 0;
    for (const { session, closeAt } of wfhStale) {
      try {
        const res = await this.sessions.autoClose(session, closeAt);
        this.latestEndCache.delete(session.id);
        if (!res.closed) continue;
        closedWfh += 1;
        await this.announceWfhAutoEnd(
          session,
          closeAt,
          res.newlyEnded,
          byId.get(session.userId) ?? null,
        );
      } catch (err) {
        this.logger.warn(
          `auto-end of work from home ${session.id} failed: ${(err as Error).message}`,
        );
      }
    }
    if (closedWfh) this.logger.log(`ended ${closedWfh} work-from-home day(s) left running`);
    if (!stale.length && !watch.length) return closedWfh;

    const queries = [...stale, ...watch].map(({ session, latestEnd }) => ({
      sessionId: session.id,
      userId: session.userId,
      from: session.startedAt,
      to: new Date(Math.max(now.getTime(), latestEnd.getTime())),
    }));
    const [lastInputs, meetingUntil] = await Promise.all([
      this.sessions.lastInputs(queries),
      this.sessions.statusMeetingsUntil(queries, now),
    ]);
    const inMeeting = watch.length
      ? await this.sessions.usersInLiveMeeting(watch.map((w) => w.session.userId))
      : new Set<string>();
    for (const w of watch) {
      // A live meeting is work without typing: never ended by the idle rule.
      if (inMeeting.has(w.session.userId)) continue;
      const due = idleCloseDue({
        ...w.basis,
        // Idle counts from the end of a status meeting, never inside it (D-22).
        lastInput: lastInputWithMeeting(
          lastInputs.get(w.session.id) ?? null,
          meetingUntil.get(w.session.id) ?? null,
        ),
        idleMin: w.idleMin,
      });
      if (now.getTime() >= due.getTime())
        stale.push({ session: w.session, latestEnd: w.latestEnd });
      else this.remember(w.session.id, due, now);
    }
    if (!stale.length) return closedWfh;

    let closed = closedWfh;
    for (const { session, latestEnd } of stale) {
      try {
        const until = meetingUntil.get(session.id) ?? null;
        const closeAt = autoCloseAt({
          startedAt: session.startedAt,
          latestEnd,
          lastInput: lastInputs.get(session.id) ?? null,
          meetingUntil: until,
        });
        const res = await this.sessions.autoClose(session, closeAt);
        this.latestEndCache.delete(session.id);
        if (!res.closed) continue;
        closed += 1;
        // A day closed once already (reopened by a replayed action) closes again
        // silently: its overseers were told the first time (re-audit M2).
        if (res.reclosed) continue;
        await this.announceAutoClose(
          session,
          closeAt,
          res.newlyEnded,
          byId.get(session.userId) ?? null,
          autoCloseMeeting(until, closeAt, now),
        );
      } catch (err) {
        this.logger.warn(`auto-close of session ${session.id} failed: ${(err as Error).message}`);
      }
    }
    if (closed) this.logger.log(`auto-closed ${closed} work session(s) with no End Day`);
    return closed;
  }

  /**
   * End of the person's shift on the session's date; null with no shift. A day off
   * that is worked runs on the shift's usual rules (3.2), so its shift end counts too.
   */
  private shiftEndFor(
    session: Pick<WorkSessionRecord, 'date'>,
    person: ShiftPerson | null,
    ctx: ResolutionContext,
  ): Date | null {
    if (!person) return null;
    const shift = this.days.resolveWith(ctx, person, session.date).shift;
    return shift ? shiftBounds(shift, session.date, this.timezone).end : null;
  }

  /**
   * latestEnd = the shift end on the session's date + autoCloseAfterShiftEndMin
   * (no shift: start + 14h), never sooner than the grace after the start (see
   * auto-close.ts). A worked day off uses its shift's end like any other day.
   */
  latestEndFor(
    session: Pick<WorkSessionRecord, 'date' | 'startedAt' | 'extendedAt'>,
    person: ShiftPerson | null,
    ctx: ResolutionContext,
    autoCloseAfterShiftEndMin: number,
  ): Date {
    const shiftEnd = this.shiftEndFor(session, person, ctx);
    return latestEndOf({
      startedAt: session.startedAt,
      shiftEnd,
      autoCloseAfterShiftEndMin,
      extendedAt: session.extendedAt ?? null,
    });
  }

  /**
   * 4.1 shared computer: the person is taking the next shift. Their open day carries
   * on (same day, no approval) until they press End Day; it is no longer auto-closed
   * at the shift end. Idempotent: the first answer's time stands.
   */
  async extend(userId: string, now: Date): Promise<{ extendedAt: Date }> {
    await this.autoCloseIfStale(userId, now);
    const open = await this.sessions.findOpen(userId);
    if (!open) throw dayClosedError('DAY_NOT_STARTED');
    const at = await this.sessions.markExtended(open.id, now);
    if (!at) throw dayClosedError('DAY_ENDED');
    this.latestEndCache.delete(open.id);
    return { extendedAt: at };
  }

  private remember(sessionId: string, latestEnd: Date, now: Date): void {
    if (this.latestEndCache.size >= LATEST_END_CACHE_MAX) this.latestEndCache.clear();
    this.latestEndCache.set(sessionId, { latestEnd: latestEnd.getTime(), at: now.getTime() });
  }

  private async announceWfhAutoEnd(
    session: WorkSessionRecord,
    closeAt: Date,
    newlyEnded: boolean,
    person: ShiftPerson | null,
  ): Promise<void> {
    const name = person ? personName(person) : 'A team member';
    try {
      if (newlyEnded) {
        await this.events.publish(
          DayEndedEvent.eventName,
          new DayEndedEvent(session.userId, name, person?.managerId ?? null, session.date, closeAt),
        );
      }
      const copy = wfhAutoEndedCopy({ endedAt: time12InZone(closeAt, this.timezone) });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([session.userId], WFH_NOTICE.WFH_AUTO_ENDED, copy.title, copy.body, null),
      );
    } catch (err) {
      this.logger.warn(
        `work-from-home end notice for ${session.userId} failed: ${(err as Error).message}`,
      );
    }
  }

  private async announceAutoClose(
    session: WorkSessionRecord,
    closeAt: Date,
    newlyEnded: boolean,
    person: ShiftPerson | null,
    meeting: AutoCloseMeeting,
  ): Promise<void> {
    const name = person ? personName(person) : 'A team member';
    try {
      if (newlyEnded) {
        // The notifications module resolves who oversees them (4.0: department
        // managers, else the organisation's Admin).
        await this.events.publish(
          DayEndedEvent.eventName,
          new DayEndedEvent(session.userId, name, null, session.date, closeAt),
        );
      }
      const at = time12InZone(closeAt, this.timezone);
      const self = dayAutoClosedSelfCopy({ closedAt: at, meeting });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([session.userId], NOTICE.DAY_AUTO_CLOSED, self.title, self.body, null),
      );
      const overseers = await this.overseersOf(person);
      if (overseers.length) {
        const mgr = dayAutoClosedManagerCopy({ name, closedAt: at, meeting });
        await this.events.publish(
          NoticeEvent.eventName,
          new NoticeEvent(overseers, NOTICE.DAY_AUTO_CLOSED, mgr.title, mgr.body, session.userId),
        );
      }
    } catch (err) {
      this.logger.warn(
        `auto-close notices for ${session.userId} failed: ${(err as Error).message}`,
      );
    }
  }

  /** 4.0: Staff → their department's managers, else the Admin; a Manager → the Admin. */
  private async overseersOf(person: ShiftPerson | null): Promise<string[]> {
    if (!person?.companyId) return [];
    let ids: string[] = [];
    if (person.role === 'USER') {
      ids = person.departmentId
        ? await this.people.listDepartmentManagerIds(person.departmentId)
        : [];
      if (!ids.length) ids = await this.people.listOrgAdminIds(person.companyId);
    } else if (person.role === 'MANAGER') {
      ids = await this.people.listOrgAdminIds(person.companyId);
    }
    return [...new Set(ids)].filter((id) => id !== person.id);
  }
}

/** Whether a status meeting, not an input, set the moment of this close (see `autoCloseAt`). */
function autoCloseMeeting(until: Date | null, closeAt: Date, now: Date): AutoCloseMeeting {
  if (until?.getTime() !== closeAt.getTime()) return null;
  return until.getTime() === now.getTime() ? 'RUNNING' : 'ENDED';
}

/** 409 for an action on a day that is not open. */
export function dayClosedError(code: 'DAY_NOT_STARTED' | 'DAY_ENDED'): ConflictError {
  return code === 'DAY_NOT_STARTED'
    ? new ConflictError(API_COPY.dayNotStarted, 'DAY_NOT_STARTED')
    : new ConflictError(API_COPY.dayEnded, 'DAY_ENDED');
}
