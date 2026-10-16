import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError } from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { appTimezone, dateKeyInZone, hmInZone } from '@shared/utils/timezone';
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
      generation === 'AGENT_31' ? 'AGENT' : 'LEGACY',
      dayOf,
    );
  }

  async endDay(userId: string, generation: AgentGeneration, now: Date): Promise<EndDayTxResult> {
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
    const [people, ctx, settings] = await Promise.all([
      this.people.findAnyByIds(userIds),
      this.days.context(userIds),
      this.settings.get(),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const stale: { session: WorkSessionRecord; latestEnd: Date }[] = [];
    for (const s of open) {
      const latestEnd = this.latestEndFor(
        s,
        byId.get(s.userId) ?? null,
        ctx,
        settings.autoCloseAfterShiftEndMin,
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
    session: WorkSessionRecord,
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
    const managerId = person?.managerId ?? null;
    try {
      if (newlyEnded) {
        await this.events.publish(
          DayEndedEvent.eventName,
          new DayEndedEvent(session.userId, name, managerId, session.date, closeAt),
        );
      }
      const at = hmInZone(closeAt, this.timezone);
      const self = dayAutoClosedSelfCopy({ closedAt: at });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([session.userId], NOTICE.DAY_AUTO_CLOSED, self.title, self.body, null),
      );
      if (managerId && managerId !== session.userId) {
        const mgr = dayAutoClosedManagerCopy({ name, closedAt: at });
        await this.events.publish(
          NoticeEvent.eventName,
          new NoticeEvent([managerId], NOTICE.DAY_AUTO_CLOSED, mgr.title, mgr.body, session.userId),
        );
      }
    } catch (err) {
      this.logger.warn(
        `auto-close notices for ${session.userId} failed: ${(err as Error).message}`,
      );
    }
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
