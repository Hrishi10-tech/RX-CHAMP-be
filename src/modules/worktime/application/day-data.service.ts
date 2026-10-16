import { Inject, Injectable } from '@nestjs/common';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
} from '@modules/shifts/domain/break-record.repository';
import { addDaysToKey, appTimezone, dateKeyInZone } from '@shared/utils/timezone';
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
 * backlog is stored for 72 hours only (report-activity), and nothing else changes
 * a closed session's samples, so its hour buckets are final.
 */
export const SETTLED_AFTER_MS = 73 * 3_600_000;
/** Settled (person, day) buckets kept per process (24 numbers each). */
const SETTLED_CACHE_MAX = 200_000;
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

  constructor(
    sessions: WorkSessionRecord[],
    presence: PresenceRow[],
    breaks: BreakRecordRow[],
    meetings: MeetingRecordRow[],
    private readonly now: Date,
  ) {
    this.sessions = group(sessions, (s) => key(s.userId, s.date));
    this.presenceByUser = group(presence, (p) => p.userId);
    this.breaks = group(breaks, (b) => key(b.userId, b.date));
    this.meetings = group(meetings, (m) => key(m.userId, m.date));
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
export class DayDataService {
  /** Hour buckets of settled days, by `tz|userId|date` (see bucketHours). */
  private readonly settled = new Map<string, readonly number[]>();

  constructor(
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly breaks: BreakRecordRepository,
    @Inject(MEETING_RECORD_REPOSITORY) private readonly meetings: MeetingRecordRepository,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    private readonly meetingService: MeetingsService,
  ) {}

  async load(
    userIds: string[],
    fromDate: string,
    toDate: string,
    now: Date,
    opts: { heal?: boolean } = {},
  ): Promise<DayDataSet> {
    if (!userIds.length) return new DayDataSet([], [], [], [], now);
    if (opts.heal) await this.meetingService.heal(userIds, now);
    const [sessions, breaks, meetings] = await Promise.all([
      this.sessions.listForUsersBetween(userIds, fromDate, toDate),
      this.breaks.listForUsersBetween(userIds, fromDate, toDate),
      this.meetings.listForUsersBetween(userIds, fromDate, toDate),
    ]);
    let presence: PresenceRow[] = [];
    if (sessions.length) {
      const from = new Date(Math.min(...sessions.map((s) => s.startedAt.getTime())));
      const to = new Date(Math.max(...sessions.map((s) => (s.endedAt ?? now).getTime())));
      const ids = [...new Set(sessions.map((s) => s.userId))];
      presence = await this.reader.presenceOverlapping(ids, from, to);
    }
    return new DayDataSet(sessions, presence, breaks, meetings, now);
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
   * longer change, so its buckets are kept in memory: a month view then only
   * aggregates the samples of its last few days.
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
    const days = await this.reader.sessionDays(
      userIds,
      fromDate,
      toDate,
      new Date(now.getTime() - SETTLED_AFTER_MS),
    );
    const live: SessionDayRow[] = [];
    for (const d of days) {
      const hit = d.settled ? this.settled.get(`${tz}|${key(d.userId, d.date)}`) : undefined;
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
