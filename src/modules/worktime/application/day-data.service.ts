import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { ActivityBackfilledEvent } from '@shared/events/activity-backfilled.event';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
} from '@modules/shifts/domain/break-record.repository';
import { addDaysToKey, appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { ACTIVITY_BACKLOG_MS } from '@modules/activity/application/activity.constants';
import { AWAY_REPOSITORY, AwayRepository, AwayRow } from '../domain/away.repository';
import { intervalsOfDay, PersonDayData } from '../domain/day';
import { buildHourly, HourActivity } from '../domain/hourly';
import {
  MEETING_RECORD_REPOSITORY,
  MeetingRecordRepository,
  MeetingRecordRow,
} from '../domain/meeting-record.repository';
import {
  WORK_SESSION_REPOSITORY,
  WorkSessionRecord,
  WorkSessionRepository,
} from '../domain/work-session.repository';
import {
  CoverageRow,
  PresenceRow,
  SessionDayRow,
  WORKTIME_READER,
  WorktimeReader,
} from '../domain/worktime.reader';
import { MeetingsService } from './meetings.service';

export { focusOfDay, intervalsOfDay, meetingsOfDay } from '../domain/day';
export type { PersonDayData } from '../domain/day';

const key = (userId: string, date: string) => `${userId}|${date}`;

/**
 * A day whose sessions all closed this long ago is settled: the agent's offline
 * backlog is stored for 7 days only (ACTIVITY_BACKLOG_MS, report-activity), and
 * nothing else changes a closed session's samples, so its hour buckets are final.
 * The hour of margin covers a backlog sample in flight at the boundary.
 */
export const SETTLED_AFTER_MS = ACTIVITY_BACKLOG_MS + 3_600_000;
/** Settled (person, day) buckets kept per process (24 numbers each). */
const SETTLED_CACHE_MAX = 200_000;
/** Closed but unsettled (person, day) buckets kept per process. */
const RECENT_CACHE_MAX = 50_000;
/**
 * The longest a closed, unsettled day's buckets are reused, as a safety net: every
 * change the API makes itself is caught sooner (sessions stamp, sample version).
 */
const RECENT_TTL_MS = 30 * 60_000;

interface RecentBuckets {
  hours: readonly number[];
  stamp: string;
  version: number;
  storedAt: number;
}

interface CachedCoverage {
  rows: CoverageRow[];
  /** The session's start and end it was read for. */
  stamp: string;
  version: number;
  storedAt: number;
  /** Ended before the backlog window: no sample can join it any more. */
  settled: boolean;
}
/** People per query when warming the cache. */
const WARM_BATCH = 200;

function group<T>(rows: T[], keyOf: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/** The loaded days of many people, read back per (person, day). */
export class DayDataSet {
  private readonly sessions: Map<string, WorkSessionRecord[]>;
  private readonly presenceByUser: Map<string, PresenceRow[]>;
  private readonly breaks: Map<string, BreakRecordRow[]>;
  private readonly meetings: Map<string, MeetingRecordRow[]>;
  private readonly away: Map<string, AwayRow[]>;
  private readonly coverageBySession: Map<string, CoverageRow[]>;

  constructor(
    sessions: WorkSessionRecord[],
    presence: PresenceRow[],
    breaks: BreakRecordRow[],
    meetings: MeetingRecordRow[],
    private readonly now: Date,
    away: AwayRow[] = [],
    coverage: CoverageRow[] = [],
  ) {
    this.sessions = group(sessions, (s) => key(s.userId, s.date));
    this.presenceByUser = group(presence, (p) => p.userId);
    this.breaks = group(breaks, (b) => key(b.userId, b.date));
    this.meetings = group(meetings, (m) => key(m.userId, m.date));
    this.away = group(away, (a) => key(a.userId, a.date));
    this.coverageBySession = group(coverage, (c) => c.sessionId);
  }

  day(userId: string, date: string): PersonDayData {
    const sessions = this.sessions.get(key(userId, date)) ?? [];
    let presence: PresenceRow[] = [];
    if (sessions.length) {
      const from = Math.min(...sessions.map((s) => s.startedAt.getTime()));
      const to = Math.max(...sessions.map((s) => (s.endedAt ?? this.now).getTime()));
      presence = (this.presenceByUser.get(userId) ?? []).filter(
        (p) => p.startedAt.getTime() < to && (p.endedAt ?? this.now).getTime() > from,
      );
    }
    return {
      userId,
      date,
      sessions,
      presence,
      breakRecords: this.breaks.get(key(userId, date)) ?? [],
      meetingRecords: this.meetings.get(key(userId, date)) ?? [],
      away: this.away.get(key(userId, date)) ?? [],
      coverage: sessions.flatMap((s) => this.coverageBySession.get(s.id) ?? []),
    };
  }

  /** Open presence sessions of a person (for live status), from what was loaded. */
  openPresence(userId: string): PresenceRow | null {
    const open = (this.presenceByUser.get(userId) ?? []).filter((p) => p.endedAt === null);
    return open.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;
  }
}

/**
 * Loads the inputs of focus time and hourly activity for many people and days
 * with one query per table (never one per person), and heals live meetings whose
 * presence session closed on the way.
 */
@Injectable()
export class DayDataService implements OnModuleInit {
  /** Hour buckets of settled days, by `tz|userId|date` (see bucketHours). */
  private readonly settled = new Map<string, readonly number[]>();
  /** Hour buckets of closed days still inside the backlog window (see bucketHours). */
  private readonly recent = new Map<string, RecentBuckets>();
  /** Activity coverage of closed REPLAY sessions, by session id (see coverageOf). */
  private readonly coverage = new Map<string, CachedCoverage>();
  /** Per person: how many times samples changed their closed days (ActivityBackfilledEvent). */
  private readonly sampleVersions = new Map<string, number>();

  constructor(
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly breaks: BreakRecordRepository,
    @Inject(MEETING_RECORD_REPOSITORY) private readonly meetings: MeetingRecordRepository,
    @Inject(AWAY_REPOSITORY) private readonly awayRepo: AwayRepository,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    private readonly meetingService: MeetingsService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<ActivityBackfilledEvent>(ActivityBackfilledEvent.eventName, (e) => {
      this.sampleVersions.set(e.userId, this.sampleVersionOf(e.userId) + 1);
    });
  }

  private sampleVersionOf(userId: string): number {
    return this.sampleVersions.get(userId) ?? 0;
  }

  async load(
    userIds: string[],
    fromDate: string,
    toDate: string,
    now: Date,
    opts: { heal?: boolean } = {},
  ): Promise<DayDataSet> {
    if (!userIds.length) return new DayDataSet([], [], [], [], now);
    if (opts.heal) await this.meetingService.heal(userIds, now);
    // Read before any sample is (see bucketHours).
    const versions = new Map(userIds.map((id) => [id, this.sampleVersionOf(id)]));
    const [sessions, breaks, meetings, away] = await Promise.all([
      this.sessions.listForUsersBetween(userIds, fromDate, toDate),
      this.breaks.listForUsersBetween(userIds, fromDate, toDate),
      this.meetings.listForUsersBetween(userIds, fromDate, toDate),
      this.awayRepo.listForUsers(userIds, fromDate, toDate),
    ]);
    let presence: PresenceRow[] = [];
    let coverage: CoverageRow[] = [];
    if (sessions.length) {
      const from = new Date(Math.min(...sessions.map((s) => s.startedAt.getTime())));
      const to = new Date(Math.max(...sessions.map((s) => (s.endedAt ?? now).getTime())));
      const ids = [...new Set(sessions.map((s) => s.userId))];
      // 4.0: activity evidence only for the sessions an offline replay opened
      // (one query for all of them, none at all on an ordinary day).
      const replayed = sessions.filter((s) => s.source === 'REPLAY');
      [presence, coverage] = await Promise.all([
        this.reader.presenceOverlapping(ids, from, to),
        replayed.length ? this.coverageOf(replayed, versions, now) : Promise.resolve([]),
      ]);
    }
    return new DayDataSet(sessions, presence, breaks, meetings, now, away, coverage);
  }

  /**
   * Activity coverage of REPLAY sessions: a closed session's coverage is kept like
   * a closed day's hour buckets (same start and end, same sample version; for at
   * most RECENT_TTL_MS until it settles), the rest is read in one query.
   */
  private async coverageOf(
    replayed: WorkSessionRecord[],
    versions: Map<string, number>,
    now: Date,
  ): Promise<CoverageRow[]> {
    const clock = Date.now();
    const settledBefore = now.getTime() - SETTLED_AFTER_MS;
    const stampOf = (s: WorkSessionRecord) =>
      `${s.startedAt.getTime()}|${s.endedAt?.getTime() ?? ''}`;
    const out: CoverageRow[] = [];
    const missing: WorkSessionRecord[] = [];
    for (const s of replayed) {
      const c = s.endedAt ? this.coverage.get(s.id) : undefined;
      const fresh =
        c &&
        c.stamp === stampOf(s) &&
        (c.settled || (c.version === versions.get(s.userId) && clock - c.storedAt < RECENT_TTL_MS));
      if (fresh) out.push(...c.rows);
      else missing.push(s);
    }
    if (!missing.length) return out;
    const read = await this.reader.activityCoverage(missing.map((s) => s.id));
    const bySession = group(read, (r) => r.sessionId);
    for (const s of missing) {
      const rows = bySession.get(s.id) ?? [];
      out.push(...rows);
      if (!s.endedAt) continue;
      if (this.coverage.size >= RECENT_CACHE_MAX) this.coverage.clear();
      this.coverage.set(s.id, {
        rows,
        stamp: stampOf(s),
        version: versions.get(s.userId) ?? 0,
        storedAt: clock,
        settled: s.endedAt.getTime() < settledBefore,
      });
    }
    return out;
  }

  /**
   * Hourly activity of one loaded day, from the same buckets as the team and
   * month views, so one day's numbers agree everywhere.
   */
  async hourlyFor(
    d: PersonDayData,
    now: Date,
    quietHourActiveMin: number,
  ): Promise<HourActivity[]> {
    const buckets = await this.bucketHours([d.userId], d.date, d.date, now);
    return this.bucketHourly(d, buckets, now, quietHourActiveMin);
  }

  /**
   * Active seconds per local hour for many people and days, aggregated in SQL.
   * A settled day (every session closed more than SETTLED_AFTER_MS ago) can no
   * longer change, so its buckets are kept in memory. A closed day still inside
   * the backlog window is kept too, while its sessions (count, last change) and
   * the person's sample version are unchanged and for at most RECENT_TTL_MS: a
   * late sample or a stamp of an older sample bumps the version (report-activity
   * announces it), a replay or an automatic close changes the sessions. A month
   * view then only aggregates the days still open.
   */
  async bucketHours(
    userIds: string[],
    fromDate: string,
    toDate: string,
    now: Date,
  ): Promise<Map<string, readonly number[]>> {
    const out = new Map<string, readonly number[]>();
    if (!userIds.length) return out;
    const tz = appTimezone();
    // Read before the samples are: a sample stored meanwhile makes this run's
    // entries stale at once, never the other way round.
    const versions = new Map(userIds.map((id) => [id, this.sampleVersionOf(id)]));
    const days = await this.reader.sessionDays(
      userIds,
      fromDate,
      toDate,
      new Date(now.getTime() - SETTLED_AFTER_MS),
    );
    const live: SessionDayRow[] = [];
    const clock = Date.now();
    for (const d of days) {
      const ck = `${tz}|${key(d.userId, d.date)}`;
      let hit: readonly number[] | undefined;
      if (d.settled) hit = this.settled.get(ck);
      else if (d.closed) {
        const r = this.recent.get(ck);
        if (
          r &&
          r.stamp === d.stamp &&
          r.version === versions.get(d.userId) &&
          clock - r.storedAt < RECENT_TTL_MS
        ) {
          hit = r.hours;
        }
      }
      if (hit) out.set(key(d.userId, d.date), hit);
      else live.push(d);
    }
    if (!live.length) return out;
    const fresh = new Map<string, number[]>();
    for (const r of await this.reader.activeSecByHour(live, tz)) {
      const k = key(r.userId, r.date);
      const hours = fresh.get(k) ?? Array<number>(24).fill(0);
      if (r.hour >= 0 && r.hour < 24) hours[r.hour] += r.activeSec;
      fresh.set(k, hours);
    }
    for (const d of live) {
      const k = key(d.userId, d.date);
      const hours = Object.freeze(fresh.get(k) ?? Array<number>(24).fill(0));
      out.set(k, hours);
      if (d.settled) this.remember(`${tz}|${k}`, hours);
      else if (d.closed && d.stamp !== undefined) {
        this.rememberRecent(`${tz}|${k}`, {
          hours,
          stamp: d.stamp,
          version: versions.get(d.userId) ?? 0,
          storedAt: clock,
        });
      }
    }
    return out;
  }

  /**
   * Fills the settled-day cache for everyone who worked this month or last month
   * (after a restart, and nightly), so the first month view is quick too.
   */
  async warmSettled(now: Date): Promise<number> {
    const tz = appTimezone();
    const today = dateKeyInZone(now, tz);
    const from = `${addDaysToKey(`${today.slice(0, 7)}-01`, -1).slice(0, 7)}-01`;
    const ids = [...(await this.reader.userIdsWithSessionsBetween(null, from, today))];
    const before = this.settled.size;
    for (let i = 0; i < ids.length; i += WARM_BATCH) {
      await this.bucketHours(ids.slice(i, i + WARM_BATCH), from, today, now);
    }
    return this.settled.size - before;
  }

  private remember(cacheKey: string, hours: readonly number[]): void {
    if (this.settled.size >= SETTLED_CACHE_MAX) this.settled.clear();
    this.settled.set(cacheKey, hours);
    this.recent.delete(cacheKey);
  }

  private rememberRecent(cacheKey: string, entry: RecentBuckets): void {
    if (this.recent.size >= RECENT_CACHE_MAX) this.recent.clear();
    this.recent.set(cacheKey, entry);
  }

  /** Hourly activity of a loaded day from SQL buckets (team and month views). */
  bucketHourly(
    d: PersonDayData,
    buckets: Map<string, readonly number[]>,
    now: Date,
    quietHourActiveMin: number,
  ): HourActivity[] {
    return buildHourly({
      dateKey: d.date,
      tz: appTimezone(),
      ...intervalsOfDay(d, now),
      activeSecByHour: buckets.get(key(d.userId, d.date)) ?? [],
      quietHourActiveMin,
    });
  }
}
