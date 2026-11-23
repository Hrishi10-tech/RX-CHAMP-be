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
  /**
   * 3.5: the departments the override is for (a holiday for some departments);
   * empty or absent: the whole organisation.
   */
  departmentIds?: string[];
}

// ---- 3.5: Saturday rules and weekly calendars for departments and people ----

export const SATURDAY_RULES = [
  'EVERY',
  'NONE',
  'OFF_2_4',
  'OFF_1_3',
  'OFF_1_3_5',
  'ALTERNATE',
] as const;
export type SaturdayRule = (typeof SATURDAY_RULES)[number];

export const SATURDAY_RULE_LABEL: Record<SaturdayRule, string> = {
  EVERY: 'Every Saturday is a working day',
  NONE: 'Every Saturday is off',
  OFF_2_4: '2nd and 4th Saturdays off',
  OFF_1_3: '1st and 3rd Saturdays off',
  OFF_1_3_5: '1st, 3rd and 5th Saturdays off',
  ALTERNATE: 'Alternate Saturdays (every other week)',
};

/** A week of working days plus a Saturday rule (a department's or a person's own). */
export interface WorkWeek {
  /** ISO weekdays worked, Monday 1 to Sunday 7 (Saturday follows `saturdays`). */
  workDays: number[];
  saturdays: SaturdayRule;
  /** ALTERNATE: a Saturday that is worked; every other week from it is worked too. */
  saturdayAnchor: string | null;
}

/** Who a day is asked for: their own calendar, then their department's, then the organisation's. */
export interface CalendarWho {
  id?: string | null;
  departmentId?: string | null;
}

/** Which week of the month a Saturday falls in (1 to 5). */
export function saturdayOrdinal(dateKey: string): number {
  return Math.floor((Number(dateKey.slice(8, 10)) - 1) / 7) + 1;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Whether a Saturday is worked under a rule. */
export function saturdayWorked(
  rule: SaturdayRule,
  anchor: string | null,
  dateKey: string,
): boolean {
  switch (rule) {
    case 'EVERY':
      return true;
    case 'NONE':
      return false;
    case 'OFF_2_4':
      return ![2, 4].includes(saturdayOrdinal(dateKey));
    case 'OFF_1_3':
      return ![1, 3].includes(saturdayOrdinal(dateKey));
    case 'OFF_1_3_5':
      return ![1, 3, 5].includes(saturdayOrdinal(dateKey));
    case 'ALTERNATE': {
      if (!anchor || !isValidDateKey(anchor)) return true;
      return Math.abs(Math.round(daysBetween(anchor, dateKey) / 7)) % 2 === 0;
    }
  }
}

/** Whether a weekly calendar works on a date. */
export function weekWorks(week: WorkWeek, dateKey: string): boolean {
  const weekday = isoWeekdayOfKey(dateKey);
  if (weekday === 6) {
    return (
      week.workDays.includes(6) && saturdayWorked(week.saturdays, week.saturdayAnchor, dateKey)
    );
  }
  return week.workDays.includes(weekday);
}

export function isSaturdayRule(value: unknown): value is SaturdayRule {
  return typeof value === 'string' && (SATURDAY_RULES as readonly string[]).includes(value);
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
  /** 3.5: the organisation's Saturday rule (absent: every Saturday of the pattern). */
  saturdays?: SaturdayRule;
  saturdayAnchor?: string | null;
  /** 3.5: departments with their own week, by department id. */
  departments?: Map<string, WorkWeek>;
  /** 3.5: people with their own week, by user id. */
  people?: Map<string, WorkWeek>;
}

/** Where a person's working day comes from (3.5: shown with a person's year). */
export type CalendarSource = 'OVERRIDE' | 'PERSON' | 'DEPARTMENT' | 'ORGANISATION';

export const CALENDAR_SOURCE_LABEL: Record<CalendarSource, string> = {
  OVERRIDE: 'A day set on the organisation calendar',
  PERSON: 'Their own calendar',
  DEPARTMENT: "Their department's calendar",
  ORGANISATION: "The organisation's week",
};

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

/**
 * The override that applies to `who` on a date: the organisation's, or one for their
 * department. One for some departments never applies when nobody is named.
 */
export function overrideFor(
  cal: OrgCalendar,
  date: string,
  who?: CalendarWho,
): DayOverride | undefined {
  const o = cal.overrides.get(date);
  if (!o) return undefined;
  if (!o.departmentIds?.length) return o;
  return who?.departmentId && o.departmentIds.includes(who.departmentId) ? o : undefined;
}

/** The organisation's own answer: its week pattern on that date, with its Saturday rule. */
function organisationWorks(cal: OrgCalendar, date: string): boolean {
  const weekday = isoWeekdayOfKey(date);
  if (!patternOn(cal, date).includes(weekday)) return false;
  if (weekday === 6 && cal.saturdays) {
    return saturdayWorked(cal.saturdays, cal.saturdayAnchor ?? null, date);
  }
  return true;
}

/** What decides a person's date (3.5: an override, their calendar, their department's, the organisation's). */
export function calendarSource(cal: OrgCalendar, date: string, who?: CalendarWho): CalendarSource {
  if (overrideFor(cal, date, who)) return 'OVERRIDE';
  if (who?.id && cal.people?.has(who.id)) return 'PERSON';
  if (who?.departmentId && cal.departments?.has(who.departmentId)) return 'DEPARTMENT';
  return 'ORGANISATION';
}

/**
 * Whether a date is a working day. 4.0: the organisation's overrides, then its week
 * pattern. 3.5: for a person, an override for their department too, then their own
 * week, their department's, and the organisation's with its Saturday rule.
 */
export function isWorkingDay(cal: OrgCalendar, date: string, who?: CalendarWho): boolean {
  const o = overrideFor(cal, date, who);
  if (o) return o.isWorking;
  const own = who?.id ? cal.people?.get(who.id) : undefined;
  if (own) return weekWorks(own, date);
  const dept = who?.departmentId ? cal.departments?.get(who.departmentId) : undefined;
  if (dept) return weekWorks(dept, date);
  return organisationWorks(cal, date);
}

export function dayLabel(cal: OrgCalendar, date: string, who?: CalendarWho): string | null {
  return overrideFor(cal, date, who)?.label ?? null;
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
