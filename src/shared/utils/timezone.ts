/**
 * Business-timezone helpers.
 *
 * Working days, break windows and hourly charts are all judged in ONE business
 * timezone (APP_TIMEZONE, default Asia/Kolkata), never the host clock. Production
 * servers run UTC, and a day key computed in UTC puts everything before 05:30 IST
 * on the previous day. These helpers take the zone explicitly so they are correct
 * whatever process.env.TZ happens to be (main.ts also pins TZ as a backstop for
 * older code that uses local-time Date getters).
 */

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

let resolvedZone: { raw: string | undefined; tz: string } | null = null;

/**
 * The configured business timezone (falls back to Asia/Kolkata when unset/invalid).
 * Validated once per value of APP_TIMEZONE: this runs on every day key and hour.
 */
export function appTimezone(): string {
  const raw = process.env.APP_TIMEZONE;
  if (resolvedZone && resolvedZone.raw === raw) return resolvedZone.tz;
  const tz = raw?.trim();
  resolvedZone = { raw, tz: tz && isValidTimezone(tz) ? tz : DEFAULT_TIMEZONE };
  return resolvedZone.tz;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock components of `date` as seen in `tz`. */
export function zonedParts(date: Date, tz: string = appTimezone()): ZonedParts {
  const out: Record<string, number> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    // Some ICU versions render midnight as 24 even with h23.
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of `tz` from UTC at the instant `utcMs`, in milliseconds (local - UTC). */
function offsetMs(utcMs: number, tz: string): number {
  const p = zonedParts(new Date(utcMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Local calendar day (YYYY-MM-DD) of `date` in `tz`. */
export function dateKeyInZone(date: Date = new Date(), tz: string = appTimezone()): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Local "HH:MM" of `date` in `tz`. */
export function hmInZone(date: Date, tz: string = appTimezone()): string {
  const p = zonedParts(date, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Local hour (0-23) of `date` in `tz`. */
export function hourInZone(date: Date, tz: string = appTimezone()): number {
  return zonedParts(date, tz).hour;
}

const HM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isValidHm(value: string): boolean {
  return HM.test(value);
}

export function isValidDateKey(value: string): boolean {
  if (!DATE_KEY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "HH:MM" -> minutes since midnight. */
export function hmToMinutes(value: string): number {
  const m = HM.exec(value);
  if (!m) throw new Error(`invalid time "${value}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes since midnight -> "HH:MM" (wraps past 24h). */
export function minutesToHm(total: number): string {
  const m = ((Math.round(total) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

const zonedCache = new Map<string, number>();
const ZONED_CACHE_MAX = 50_000;

/**
 * The UTC instant at which the wall clock in `tz` reads `dateKey` + `minutes`
 * after midnight. `minutes` may exceed 1440 (a time on the following day).
 * DST-safe: the offset is re-checked at the resulting instant.
 */
export function zonedMinutesToUtc(
  dateKey: string,
  minutes: number,
  tz: string = appTimezone(),
): Date {
  // Shift bounds, break slots and hour windows ask for the same few instants of a
  // day again and again (a month report: every person, every day): cached.
  const cacheKey = `${tz}|${dateKey}|${minutes}`;
  const hit = zonedCache.get(cacheKey);
  if (hit !== undefined) return new Date(hit);
  const [y, mo, d] = dateKey.split('-').map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0) + minutes * 60_000;
  const first = offsetMs(guess, tz);
  let utc = guess - first;
  const second = offsetMs(utc, tz);
  if (second !== first) utc = guess - second;
  if (zonedCache.size >= ZONED_CACHE_MAX) zonedCache.clear();
  zonedCache.set(cacheKey, utc);
  return new Date(utc);
}

/** Convenience: the instant `dateKey` "HH:MM" in `tz`. */
export function zonedTimeToUtc(dateKey: string, hm: string, tz: string = appTimezone()): Date {
  return zonedMinutesToUtc(dateKey, hmToMinutes(hm), tz);
}

/** `dateKey` shifted by `days` calendar days. */
export function addDaysToKey(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** ISO weekday of a calendar day: 1 = Monday ... 7 = Sunday. */
export function isoWeekdayOfKey(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Start of the local day `dateKey` in `tz`, as a UTC instant. */
export function startOfDayInZone(dateKey: string, tz: string = appTimezone()): Date {
  return zonedMinutesToUtc(dateKey, 0, tz);
}
