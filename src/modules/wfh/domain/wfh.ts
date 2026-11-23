import { addDaysToKey, isoWeekdayOfKey, isValidDateKey } from '@shared/utils/timezone';
import {
  formatDays,
  isKind,
  isPart,
  KIND_PARTS,
  kindLabel,
  LeaveKind,
  LeavePart,
  LeaveStatus,
  maskOf,
  UNITS_PER_DAY,
  unitsOfMask,
} from '@modules/leave/domain/leave.types';
import {
  leaveDay,
  leaveSpan,
  MAX_RANGE_DAYS,
  REASON_MAX,
  REASON_MIN,
  spanDays,
} from '@modules/leave/domain/request-rules';
import { DeciderRole } from '@modules/leave/domain/routing';
import { WfhPolicy } from './wfh-policy';

/**
 * Work from home (3.5), as pure functions: requests, schedules, the day's share
 * and the credit cap. Counted in quarter days like leave (a full day is 4).
 */

export interface WfhDayRecord {
  date: string;
  mask: number;
  units: number;
}

export interface WfhRequestRecord {
  id: string;
  userId: string;
  kind: LeaveKind;
  part: LeavePart | null;
  startDate: string;
  endDate: string;
  units: number;
  reason: string;
  status: LeaveStatus;
  approverRole: DeciderRole | null;
  approverId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  days: WfhDayRecord[];
}

export interface WfhScheduleRecord {
  id: string;
  userId: string;
  weekdays: number[];
  /** Weeks of the month (1 to 5); empty: every week. */
  weeks: number[];
  kind: LeaveKind;
  part: LeavePart | null;
  fromDate: string;
  toDate: string | null;
  skipDates: string[];
  note: string;
  createdById: string;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A person's work from home on one day, as other modules read it. */
export interface WfhDay {
  /** Quarters approved (a request or a schedule), less any approved leave. */
  mask: number;
  units: number;
  /** Quarters asked for and waiting. */
  pendingMask: number;
  /** What it came from: a request, a schedule, or both. */
  source: 'REQUEST' | 'SCHEDULE' | 'BOTH' | null;
  /** The longest the day's work from home can credit (seconds; 0 without any). */
  capSec: number;
}

export const NO_WFH: Readonly<WfhDay> = Object.freeze({
  mask: 0,
  units: 0,
  pendingMask: 0,
  source: null,
  capSec: 0,
});

/** userId -> date -> work from home that day */
export type WfhByDay = Map<string, Map<string, WfhDay>>;

export function wfhOn(map: WfhByDay | undefined, userId: string, date: string): WfhDay {
  return map?.get(userId)?.get(date) ?? NO_WFH;
}

/** Which week of its month a day is, by its weekday (the 1st Wednesday is week 1). */
export function weekOfMonth(dateKey: string): number {
  return Math.floor((Number(dateKey.slice(8, 10)) - 1) / 7) + 1;
}

/** Whether a schedule covers `dateKey` (before working days and leave are applied). */
export function scheduleCovers(s: WfhScheduleRecord, dateKey: string): boolean {
  if (dateKey < s.fromDate) return false;
  if (s.toDate && dateKey > s.toDate) return false;
  if (!s.weekdays.includes(isoWeekdayOfKey(dateKey))) return false;
  if (s.weeks.length && !s.weeks.includes(weekOfMonth(dateKey))) return false;
  return !s.skipDates.includes(dateKey);
}

/** The pattern's dates from `from` to `to` (inclusive). */
export function scheduleDates(s: WfhScheduleRecord, from: string, to: string): string[] {
  const out: string[] = [];
  const start = from > s.fromDate ? from : s.fromDate;
  const end = s.toDate && s.toDate < to ? s.toDate : to;
  for (let d = start; d <= end; d = addDaysToKey(d, 1)) if (scheduleCovers(s, d)) out.push(d);
  return out;
}

/** The credit cap for a day: the basis times the day's share (a half day: half). */
export function capSecOf(basisSec: number, mask: number): number {
  return Math.round((Math.max(0, basisSec) * unitsOfMask(mask)) / UNITS_PER_DAY);
}

const WEEKDAY_NAME = [
  '',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const ORDINAL = ['', '1st', '2nd', '3rd', '4th', '5th'];

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Every Wednesday, full day", "1st and 3rd Fridays, half day (second half)". */
export function scheduleLabel(
  s: Pick<WfhScheduleRecord, 'weekdays' | 'weeks' | 'kind' | 'part'>,
): string {
  const names = [...s.weekdays].sort((a, b) => a - b).map((d) => WEEKDAY_NAME[d] ?? '');
  const when = s.weeks.length
    ? `${joinList([...s.weeks].sort((a, b) => a - b).map((w) => ORDINAL[w] ?? `${w}th`))} ${joinList(names.map((n) => `${n}s`))}`
    : `Every ${joinList(names)}`;
  return `${when}, ${kindLabel(s.kind, s.part).toLowerCase()}`;
}

/** The label for the middle of a sentence: "every Wednesday, full day" (weekday names keep their capital). */
export function scheduleLabelInSentence(
  s: Pick<WfhScheduleRecord, 'weekdays' | 'weeks' | 'kind' | 'part'>,
): string {
  const label = scheduleLabel(s);
  return label.startsWith('Every ') ? `every ${label.slice(6)}` : label;
}

// ---- Checks -------------------------------------------------------------------------

export interface WfhInput {
  kind: unknown;
  part?: unknown;
  startDate: unknown;
  endDate?: unknown;
  reason: unknown;
}

export interface WfhShape {
  kind: LeaveKind;
  part: LeavePart | null;
  startDate: string;
  endDate: string;
  reason: string;
}

export type WfhShapeResult =
  | { ok: true; value: WfhShape }
  | { ok: false; field: string; code: string; message: string };

function fail(field: string, code: string, message: string): WfhShapeResult {
  return { ok: false, field, code, message };
}

/** Kind and part as a request or a schedule gives them. */
export function checkKindPart(
  kind: unknown,
  part: unknown,
):
  | { ok: true; kind: LeaveKind; part: LeavePart | null }
  | { ok: false; field: string; message: string } {
  if (!isKind(kind)) {
    return { ok: false, field: 'kind', message: 'Pick a full day, a half day or a quarter day.' };
  }
  const parts = KIND_PARTS[kind];
  if (parts.length) {
    if (!isPart(part) || !parts.includes(part)) {
      return {
        ok: false,
        field: 'part',
        message:
          kind === 'HALF_DAY'
            ? 'Pick the first half or the second half of the day.'
            : 'Pick which quarter of the day (1st to 4th).',
      };
    }
    return { ok: true, kind, part };
  }
  if (part !== undefined && part !== null && part !== '') {
    return { ok: false, field: 'part', message: 'A full day has no part.' };
  }
  return { ok: true, kind, part: null };
}

/** A request on its own terms and against the notice, for a request made on `today`. */
export function checkWfhRequest(
  input: WfhInput,
  ctx: { today: string; policy: WfhPolicy },
): WfhShapeResult {
  const kp = checkKindPart(input.kind, input.part);
  if (!kp.ok) return fail(kp.field, 'VALIDATION_ERROR', kp.message);
  if (typeof input.startDate !== 'string' || !isValidDateKey(input.startDate)) {
    return fail('startDate', 'VALIDATION_ERROR', 'The first day must be a real day (YYYY-MM-DD).');
  }
  const startDate = input.startDate;
  let endDate = startDate;
  const end = input.endDate;
  if (end !== undefined && end !== null && end !== '') {
    if (typeof end !== 'string' || !isValidDateKey(end)) {
      return fail('endDate', 'VALIDATION_ERROR', 'The last day must be a real day (YYYY-MM-DD).');
    }
    endDate = end;
  }
  if (kp.kind !== 'FULL_DAY' && endDate !== startDate) {
    return fail(
      'endDate',
      'VALIDATION_ERROR',
      'A half or quarter day is one day: leave out the last day.',
    );
  }
  if (endDate < startDate)
    return fail('endDate', 'VALIDATION_ERROR', 'The last day is before the first day.');
  if (spanDays(startDate, endDate) > MAX_RANGE_DAYS) {
    return fail(
      'endDate',
      'RANGE_TOO_LONG',
      `One request covers at most ${MAX_RANGE_DAYS} days. Ask for a schedule for regular work from home.`,
    );
  }
  const earliest = addDaysToKey(ctx.today, ctx.policy.noticeDays);
  if (startDate < earliest) {
    const n = ctx.policy.noticeDays;
    return fail(
      'startDate',
      n === 0 ? 'IN_THE_PAST' : 'NOTICE_TOO_SHORT',
      n === 0
        ? 'Work from home cannot be asked for a day that has passed.'
        : `Work from home is asked ${n} ${n === 1 ? 'day' : 'days'} ahead: the first day can be ` +
            `${leaveDay(earliest)} at the earliest.`,
    );
  }
  const limit = addDaysToKey(ctx.today, 370);
  if (startDate > limit) {
    return fail('startDate', 'TOO_FAR_AHEAD', 'Work from home can be asked up to a year ahead.');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return fail(
      'reason',
      'VALIDATION_ERROR',
      `Give a reason, ${REASON_MIN} to ${REASON_MAX} characters.`,
    );
  }
  return { ok: true, value: { kind: kp.kind, part: kp.part, startDate, endDate, reason } };
}

export interface WfhDayInfo {
  date: string;
  workday: boolean;
  /** "Holiday: Diwali", "Weekly day off". */
  offLabel: string | null;
  /** Quarters on leave that day (approved or waiting). */
  leaveMask: number;
  /** Quarters already scheduled as work from home. */
  scheduledMask: number;
}

/** The days a request covers, and those it skips (with why); clashes are found separately. */
export function priceWfhDays(
  kind: LeaveKind,
  part: LeavePart | null,
  days: readonly WfhDayInfo[],
): { covered: WfhDayRecord[]; skipped: { date: string; why: string }[] } {
  const mask = maskOf(kind, part);
  const units = unitsOfMask(mask);
  const covered: WfhDayRecord[] = [];
  const skipped: { date: string; why: string }[] = [];
  for (const d of days) {
    if (!d.workday) skipped.push({ date: d.date, why: d.offLabel ?? 'Not a working day' });
    else if ((d.leaveMask & 0b1111) === 0b1111) skipped.push({ date: d.date, why: 'On leave' });
    else covered.push({ date: d.date, mask, units });
  }
  return { covered, skipped };
}

/** "Work from home, full day", "Work from home, 3 days". */
export function wfhWhat(r: {
  startDate: string;
  endDate: string;
  units: number;
  kind: LeaveKind;
  part: LeavePart | null;
}): string {
  if (r.startDate === r.endDate && r.units < UNITS_PER_DAY) {
    return `Work from home, ${kindLabel(r.kind, r.part).toLowerCase().replace(' (', ', ').replace(')', '')}`;
  }
  return `Work from home, ${formatDays(r.units)}`;
}

export { leaveDay as wfhDay, leaveSpan as wfhSpan };
