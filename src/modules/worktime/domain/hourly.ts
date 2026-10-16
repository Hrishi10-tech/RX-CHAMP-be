import { addDaysToKey, zonedMinutesToUtc } from '@shared/utils/timezone';
import { Interval, intersect, normalize } from './intervals';

/**
 * Hourly activity for managers (SPEC 1.8), as pure functions.
 *
 * A QUIET hour has at least 50 available minutes (inside the work session, not on
 * a break or in a meeting), no break or meeting overlapping it at all, and fewer
 * than `quietHourActiveMin` active minutes. Quiet hours never change focus time.
 */

export interface HourActivity {
  hour: number;
  activeMin: number;
  availableMin: number;
  breakMin: number;
  meetingMin: number;
  quiet: boolean;
}

export const QUIET_MIN_AVAILABLE_MIN = 50;

const windowCache = new Map<string, Interval[]>();
const WINDOW_CACHE_MAX = 2_000;

/** The 24 local hours of a business day as UTC intervals (hour 0..23); cached. */
export function hourWindows(dateKey: string, tz: string): Interval[] {
  const cacheKey = `${tz}|${dateKey}`;
  const hit = windowCache.get(cacheKey);
  if (hit) return hit;
  const out: Interval[] = [];
  for (let h = 0; h < 24; h++) {
    out.push({
      start: zonedMinutesToUtc(dateKey, h * 60, tz).getTime(),
      end: zonedMinutesToUtc(dateKey, (h + 1) * 60, tz).getTime(),
    });
  }
  if (windowCache.size >= WINDOW_CACHE_MAX) windowCache.clear();
  windowCache.set(cacheKey, out);
  return out;
}

/** Overlap in ms of one window with a sorted list of disjoint intervals. */
function overlapIn(list: Interval[], w: Interval): number {
  let sum = 0;
  for (const i of list) {
    if (i.start >= w.end) break;
    if (i.end > w.start) sum += Math.min(i.end, w.end) - Math.max(i.start, w.start);
  }
  return sum;
}

/**
 * The 24 clock hours of a working day: hour h is h:00 on the day itself, or on the
 * next calendar day when the day's work lies there (a night shift's hours after
 * midnight). Matches the SQL buckets, which file samples by the session's day and
 * the clock hour.
 */
export function dayHourWindows(dateKey: string, tz: string, work: Interval[]): Interval[] {
  const base = hourWindows(dateKey, tz);
  const w = normalize(work);
  // Work that ends within the day itself (nearly every day) needs no comparison.
  if (!w.length || w[w.length - 1].end <= base[23].end) return base;
  const next = hourWindows(addDaysToKey(dateKey, 1), tz);
  return base.map((h, i) => (overlapIn(w, next[i]) > overlapIn(w, h) ? next[i] : h));
}

export interface HourlyInput {
  dateKey: string;
  tz: string;
  /** Work session intervals (open sessions already cut at now). */
  work: Interval[];
  /** BREAK and LUNCH presence intervals. */
  breaks: Interval[];
  /** MEETING presence and PAST meeting intervals. */
  meetings: Interval[];
  /** Active seconds per local hour, index 0..23 (missing = 0). */
  activeSecByHour: readonly number[];
  quietHourActiveMin: number;
}

const min = (ms: number) => Math.round(ms / 60_000);

export function buildHourly(input: HourlyInput): HourActivity[] {
  const work = normalize(input.work);
  const breaks = normalize(input.breaks);
  const meetings = normalize(input.meetings);
  // Work time on a break or in a meeting, once for the day (sorted and disjoint).
  const workAway = intersect(work, normalize([...breaks, ...meetings]));
  return dayHourWindows(input.dateKey, input.tz, work).map((h, hour) => {
    const workMs = overlapIn(work, h);
    const breakMs = overlapIn(breaks, h);
    const meetingMs = overlapIn(meetings, h);
    const availableMs = Math.max(0, workMs - overlapIn(workAway, h));
    const activeMin = Math.min(
      60,
      Math.max(0, Math.round((input.activeSecByHour[hour] ?? 0) / 60)),
    );
    const availableMin = min(availableMs);
    return {
      hour,
      activeMin,
      availableMin,
      breakMin: min(breakMs),
      meetingMin: min(meetingMs),
      quiet:
        availableMs >= QUIET_MIN_AVAILABLE_MIN * 60_000 &&
        breakMs === 0 &&
        meetingMs === 0 &&
        activeMin < input.quietHourActiveMin,
    };
  });
}

export function quietHoursOf(hours: HourActivity[]): number {
  return hours.filter((h) => h.quiet).length;
}

export function activeMinOf(hours: HourActivity[]): number {
  return hours.reduce((sum, h) => sum + h.activeMin, 0);
}
