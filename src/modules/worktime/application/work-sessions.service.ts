import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError } from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { RequestClock } from '@shared/tenancy';
import { NoticeEvent } from '@shared/events/notice.event';
import { appTimezone, dateKeyInZone, time12InZone } from '@shared/utils/timezone';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService, ResolutionContext } from '@modules/shifts/application/break-day.service';
import { personName } from '@modules/shifts/application/break-events.service';
import { ShiftDayResolver } from '@modules/shifts/application/shift-day.resolver';
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
import { autoCloseAt, isStale, latestEndOf } from '../domain/auto-close';
import { START_DAY_BACKDATE_MS } from '../domain/meetings';
import { dayAutoClosedManagerCopy, dayAutoClosedSelfCopy, NOTICE } from '../domain/notice-copy';
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
  ) {}

  get timezone(): string {
    return appTimezone();
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
    s: Pick<WorkSessionRecord, 'userId' | 'date' | 'startedAt'>,
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

  async startDay(
    userId: string,
    startedAt: Date,
    generation: AgentGeneration,
    now: Date,
  ): Promise<StartDayTxResult> {
    await this.autoCloseIfStale(userId, now);
    const dayOf = await this.dayKeys.keyFnFor(userId);
    return this.sessions.startDay(
      userId,
      startedAt,
      now,
      RequestClock.isReplay() ? 'REPLAY' : generation === 'AGENT_31' ? 'AGENT' : 'LEGACY',
      dayOf,
    );
  }

  async endDay(userId: string, generation: AgentGeneration, now: Date): Promise<EndDayTxResult> {
    // 4.0: a paused break ends at its pause before the day closes.
    await this.breakRecords.endPaused(userId);
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
    const cached = this.latestEndCache.get(open.id);
    if (
      cached &&
      now.getTime() - cached.at < LATEST_END_TTL_MS &&
      now.getTime() <= cached.latestEnd
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
    for (const s of open) {
      const person = byId.get(s.userId) ?? null;
      const latestEnd = this.latestEndFor(
        s,
        person,
        ctx,
        settingsByOrg.get(person?.companyId ?? null)!.autoCloseAfterShiftEndMin,
      );
      this.remember(s.id, latestEnd, now);
      if (isStale(latestEnd, now)) stale.push({ session: s, latestEnd });
    }
    if (!stale.length) return 0;

    const lastInputs = await this.sessions.lastInputs(
      stale.map(({ session, latestEnd }) => ({
        sessionId: session.id,
        userId: session.userId,
        from: session.startedAt,
        to: new Date(Math.max(now.getTime(), latestEnd.getTime())),
      })),
    );
    let closed = 0;
    for (const { session, latestEnd } of stale) {
      try {
        const closeAt = autoCloseAt({
          startedAt: session.startedAt,
          latestEnd,
          lastInput: lastInputs.get(session.id) ?? null,
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
        );
      } catch (err) {
        this.logger.warn(`auto-close of session ${session.id} failed: ${(err as Error).message}`);
      }
    }
    if (closed) this.logger.log(`auto-closed ${closed} work session(s) with no End Day`);
    return closed;
  }

  /**
   * latestEnd = the shift end on the session's date + autoCloseAfterShiftEndMin
   * (no shift or a day off: start + 14h), never sooner than the grace after the
   * start (see auto-close.ts).
   */
  latestEndFor(
    session: Pick<WorkSessionRecord, 'date' | 'startedAt'>,
    person: ShiftPerson | null,
    ctx: ResolutionContext,
    autoCloseAfterShiftEndMin: number,
  ): Date {
    let shiftEnd: Date | null = null;
    if (person) {
      const day = this.days.forDate(this.days.resolveWith(ctx, person, session.date), session.date);
      if (day.resolved.shift && day.workday) {
        shiftEnd = shiftBounds(day.resolved.shift, session.date, this.timezone).end;
      }
    }
    return latestEndOf({ startedAt: session.startedAt, shiftEnd, autoCloseAfterShiftEndMin });
  }

  private remember(sessionId: string, latestEnd: Date, now: Date): void {
    if (this.latestEndCache.size >= LATEST_END_CACHE_MAX) this.latestEndCache.clear();
    this.latestEndCache.set(sessionId, { latestEnd: latestEnd.getTime(), at: now.getTime() });
  }

  private async announceAutoClose(
    session: WorkSessionRecord,
    closeAt: Date,
    newlyEnded: boolean,
    person: ShiftPerson | null,
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
      const self = dayAutoClosedSelfCopy({ closedAt: at });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([session.userId], NOTICE.DAY_AUTO_CLOSED, self.title, self.body, null),
      );
      const overseers = await this.overseersOf(person);
      if (overseers.length) {
        const mgr = dayAutoClosedManagerCopy({ name, closedAt: at });
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

/** 409 for an action on a day that is not open. */
export function dayClosedError(code: 'DAY_NOT_STARTED' | 'DAY_ENDED'): ConflictError {
  return code === 'DAY_NOT_STARTED'
    ? new ConflictError('Your day has not started. Press Start Day first.', 'DAY_NOT_STARTED')
    : new ConflictError(
        'Your working day has already ended. Press Start Day to resume.',
        'DAY_ENDED',
      );
}
