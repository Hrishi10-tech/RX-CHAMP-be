import { addDaysToKey, isoWeekdayOfKey, isValidDateKey } from '@shared/utils/timezone';

/**
 * Working days and holidays of an organisation (docs/4.0/SPEC.md 2.6). Pure.
 *
 *   isWorkingDay(date) = override?.isWorking ?? patternOn(date).includes(isoWeekday(date))
 *   patternOn(date)    = the days of the latest pattern entry with from <= date
 *
 * The week pattern (ISO weekdays 1 = Monday .. 7 = Sunday, default Monday to
 * Saturday) is effective from a date: the organisation settings row keeps its
 * history (`weekPatternHistory`, [{from: 'YYYY-MM-DD', days}], oldest first). The
 * 3.x single `weekPattern` is the entry from the beginning of time, so changing
 * the pattern never rewrites the days before the change (a month locked for
 * payroll keeps the pattern it was locked with). Per-date overrides live in
 * calendar_days (a holiday is a non-working override with a label).
 */

export const DEFAULT_WEEK_PATTERN: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6]);
export const LABEL_MAX = 60;
/** The `from` of the first pattern entry: it has applied since the beginning of time. */
export const PATTERN_SINCE_ALWAYS = '0000-01-01';

export interface DayOverride {
  isWorking: boolean;
  label: string | null;
}

/** One week pattern and the date it applies from (until the next entry's). */
export interface WeekPatternEntry {
  from: string;
  days: number[];
}

export interface OrgCalendar {
  /** The pattern in force today (also the pattern of every date when there is no history). */
  weekPattern: number[];
  /** The pattern history, oldest first; the first entry runs from PATTERN_SINCE_ALWAYS. */
  patterns?: WeekPatternEntry[];
  overrides: Map<string, DayOverride>;
}

/** The week pattern that applies on `date`. */
export function patternOn(cal: OrgCalendar, date: string): number[] {
  const history = cal.patterns;
  if (!history?.length) return cal.weekPattern;
  let days: number[] | null = null;
  for (const e of history) {
    if (e.from <= date) days = e.days;
    else break;
  }
  return days ?? history[0].days;
}

/**
 * The pattern history from what is stored: `weekPatternHistory` when present and
 * sound, else the single 3.x `weekPattern` from the beginning of time. Entries are
 * sorted by date (one per date, the last stored wins), and the first always runs
 * from the beginning of time.
 */
export function patternHistoryFromStored(history: unknown, legacy: unknown): WeekPatternEntry[] {
  const base: WeekPatternEntry = {
    from: PATTERN_SINCE_ALWAYS,
    days: weekPatternFromStored(legacy),
  };
  if (!Array.isArray(history)) return [base];
  const byFrom = new Map<string, number[]>();
  for (const raw of history) {
    if (!raw || typeof raw !== 'object') continue;
    const { from, days } = raw as { from?: unknown; days?: unknown };
    if (typeof from !== 'string' || (from !== PATTERN_SINCE_ALWAYS && !isValidDateKey(from)))
      continue;
    if (!Array.isArray(days)) continue;
    byFrom.set(from, weekPatternFromStored(days));
  }
  const entries = [...byFrom.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([from, days]) => ({ from, days }));
  if (!entries.length) return [base];
  if (entries[0].from !== PATTERN_SINCE_ALWAYS) entries.unshift(base);
  return entries;
}

/**
 * The history with `days` in force from `from` on: entries from that date on are
 * replaced (the newest decision holds from its date), earlier ones are kept.
 */
export function withPatternFrom(
  history: WeekPatternEntry[],
  from: string,
  days: number[],
): WeekPatternEntry[] {
  const kept = history.filter((e) => e.from < from);
  // The same days as the week already in force: nothing new starts (no duplicate entry).
  const last = kept[kept.length - 1];
  if (last && last.days.length === days.length && last.days.every((d, i) => d === days[i])) {
    return kept;
  }
  return [...kept, { from, days: [...days] }];
}

/** The pattern from what is stored (defaults for anything missing or invalid). */
export function weekPatternFromStored(stored: unknown): number[] {
  if (!Array.isArray(stored)) return [...DEFAULT_WEEK_PATTERN];
  const days = [
    ...new Set(stored.filter((d): d is number => Number.isInteger(d) && d >= 1 && d <= 7)),
  ];
  return days.sort((a, b) => a - b);
}

/** A validated week pattern, or the problem with it. */
export function checkWeekPattern(
  days: unknown,
): { ok: true; days: number[] } | { ok: false; message: string } {
  if (!Array.isArray(days))
    return { ok: false, message: 'days must be a list of weekdays (1 = Monday to 7 = Sunday).' };
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    return { ok: false, message: 'Each weekday is a whole number from 1 (Monday) to 7 (Sunday).' };
  }
  const unique = [...new Set(days as number[])].sort((a, b) => a - b);
  return { ok: true, days: unique };
}

export function cleanLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const t = label.trim().replace(/\s+/g, ' ');
  return t ? t.slice(0, LABEL_MAX) : null;
}

export function isWorkingDay(cal: OrgCalendar, date: string): boolean {
  const o = cal.overrides.get(date);
  if (o) return o.isWorking;
  return patternOn(cal, date).includes(isoWeekdayOfKey(date));
}

export function dayLabel(cal: OrgCalendar, date: string): string | null {
  return cal.overrides.get(date)?.label ?? null;
}

/** Every date of a month ("2026-10" -> "2026-10-01" .. "2026-10-31"). */
export function datesOfMonth(month: string): string[] {
  const out: string[] = [];
  let d = `${month}-01`;
  while (d.startsWith(month)) {
    out.push(d);
    d = addDaysToKey(d, 1);
  }
  return out;
}

export interface MonthSummary {
  month: string;
  workingDays: number;
  holidays: { date: string; label: string | null }[];
}

/** Working days of a month and its holidays (non-working overrides on pattern days, or labelled ones). */
export function monthSummary(cal: OrgCalendar, month: string): MonthSummary {
  let workingDays = 0;
  const holidays: { date: string; label: string | null }[] = [];
  for (const date of datesOfMonth(month)) {
    if (isWorkingDay(cal, date)) workingDays += 1;
    const o = cal.overrides.get(date);
    if (o && !o.isWorking && (o.label || patternOn(cal, date).includes(isoWeekdayOfKey(date)))) {
      holidays.push({ date, label: o.label });
    }
  }
  return { month, workingDays, holidays };
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

export { isValidDateKey };
