import { addDaysToKey, isoWeekdayOfKey, isValidDateKey } from '@shared/utils/timezone';
import { LeavePolicy } from './leave-policy';
import {
  CATEGORY_LABEL,
  isCategory,
  isKind,
  isPart,
  KIND_PARTS,
  LeaveCategory,
  LeaveKind,
  LeavePart,
  maskOf,
  unitsOfMask,
} from './leave.types';

/**
 * What makes a leave request acceptable (3.4). Pure: no Nest, no Prisma. The
 * service adds what needs the database: working days, overlaps, the balance and
 * month locks.
 */

export const REASON_MIN = 3;
export const REASON_MAX = 300;
export const NOTE_MIN = 3;
export const NOTE_MAX = 300;
/** A range of full days spans at most this many calendar days. */
export const MAX_RANGE_DAYS = 31;

export interface RequestInput {
  category: unknown;
  kind: unknown;
  part?: unknown;
  startDate: unknown;
  endDate?: unknown;
  reason: unknown;
}

export interface RequestShape {
  category: LeaveCategory;
  kind: LeaveKind;
  part: LeavePart | null;
  startDate: string;
  endDate: string;
  year: number;
  reason: string;
}

export type ShapeResult =
  | { ok: true; value: RequestShape }
  | { ok: false; field: string; code: string; message: string };

const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11-09" -> "Mon 9 Nov". */
export function leaveDay(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${WEEKDAY[isoWeekdayOfKey(dateKey) - 1]} ${d} ${MONTH[m - 1]}`;
}

/** "Mon 9 Nov", "Mon 9 to Fri 13 Nov", "Mon 28 Dec to Thu 31 Dec". */
export function leaveSpan(startDate: string, endDate: string): string {
  if (startDate === endDate) return leaveDay(startDate);
  const [, sm, sd] = startDate.split('-').map(Number);
  const [, em] = endDate.split('-').map(Number);
  const start =
    sm === em ? `${WEEKDAY[isoWeekdayOfKey(startDate) - 1]} ${sd}` : leaveDay(startDate);
  return `${start} to ${leaveDay(endDate)}`;
}

/** Calendar days from a to b inclusive. */
export function spanDays(a: string, b: string): number {
  const ms = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000) + 1;
}

function fail(field: string, code: string, message: string): ShapeResult {
  return { ok: false, field, code, message };
}

/**
 * The request on its own terms and against the policy's timing rules, for a
 * request made on `today` (business time zone).
 */
export function checkRequest(
  input: RequestInput,
  ctx: { today: string; policy: LeavePolicy; joinDate?: string },
): ShapeResult {
  if (!isCategory(input.category)) {
    return fail('category', 'VALIDATION_ERROR', 'Pick CL/SL, EL/PL or Comp off.');
  }
  if (!isKind(input.kind)) {
    return fail('kind', 'VALIDATION_ERROR', 'Pick a full day, a half day or a quarter day.');
  }
  const category = input.category;
  const kind = input.kind;
  let part: LeavePart | null = null;
  const parts = KIND_PARTS[kind];
  if (parts.length) {
    if (!isPart(input.part) || !parts.includes(input.part)) {
      return fail(
        'part',
        'VALIDATION_ERROR',
        kind === 'HALF_DAY'
          ? 'Pick the first half or the second half of the day.'
          : 'Pick which quarter of the day (1st to 4th).',
      );
    }
    part = input.part;
  } else if (input.part !== undefined && input.part !== null && input.part !== '') {
    return fail('part', 'VALIDATION_ERROR', 'A full day has no part.');
  }

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
  if (kind !== 'FULL_DAY' && endDate !== startDate) {
    return fail(
      'endDate',
      'VALIDATION_ERROR',
      'A half or quarter day is one day: leave out the last day.',
    );
  }
  if (endDate < startDate) {
    return fail('endDate', 'VALIDATION_ERROR', 'The last day is before the first day.');
  }
  if (spanDays(startDate, endDate) > MAX_RANGE_DAYS) {
    return fail(
      'endDate',
      'RANGE_TOO_LONG',
      `One request covers at most ${MAX_RANGE_DAYS} days. Split a longer leave into two requests.`,
    );
  }
  if (startDate.slice(0, 4) !== endDate.slice(0, 4)) {
    return fail(
      'endDate',
      'CROSSES_YEAR',
      `Leave is counted per calendar year: apply up to 31 Dec, then from 1 Jan in a second request.`,
    );
  }
  const year = Number(startDate.slice(0, 4));
  const thisYear = Number(ctx.today.slice(0, 4));
  if (year > thisYear + 1) {
    return fail(
      'startDate',
      'TOO_FAR_AHEAD',
      `Leave can be applied for ${thisYear} and ${thisYear + 1} only.`,
    );
  }
  if (ctx.joinDate && startDate < ctx.joinDate) {
    return fail(
      'startDate',
      'BEFORE_JOINING',
      `You joined on ${leaveDay(ctx.joinDate)}: leave can cover days from then on.`,
    );
  }
  const started = ctx.policy.startedOn;
  if (started && year < Number(started.slice(0, 4))) {
    return fail(
      'startDate',
      'BEFORE_LEAVE_STARTED',
      `Leave in RX Vision starts in ${started.slice(0, 4)}.`,
    );
  }

  if (category === 'ELPL') {
    const earliest = addDaysToKey(ctx.today, ctx.policy.elplNoticeDays);
    if (startDate < earliest) {
      const notice = ctx.policy.elplNoticeDays;
      return fail(
        'startDate',
        'NOTICE_TOO_SHORT',
        `${CATEGORY_LABEL.ELPL} needs ${notice} ${notice === 1 ? "day's" : "days'"} notice: ` +
          `the first day can be ${leaveDay(earliest)} at the earliest. For today or a sudden absence, use ${CATEGORY_LABEL.CLSL}.`,
      );
    }
  } else {
    // CL/SL, and comp off (3.5) on the same timing: today, ahead, or a few days back.
    const earliest = addDaysToKey(ctx.today, -ctx.policy.clslBackdateDays);
    if (startDate < earliest) {
      const back = ctx.policy.clslBackdateDays;
      return fail(
        'startDate',
        'TOO_FAR_BACK',
        back === 0
          ? `${CATEGORY_LABEL[category]} cannot be applied for a day that has passed.`
          : `${CATEGORY_LABEL[category]} can cover up to ${back} ${back === 1 ? 'day' : 'days'} back: ` +
              `the first day can be ${leaveDay(earliest)} at the earliest.`,
      );
    }
  }

  const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
    return fail(
      'reason',
      'VALIDATION_ERROR',
      `Give a reason, ${REASON_MIN} to ${REASON_MAX} characters.`,
    );
  }
  return { ok: true, value: { category, kind, part, startDate, endDate, year, reason } };
}

/** A decision note: optional on approval, required on rejection and revocation. */
export function checkNote(
  note: unknown,
  required: boolean,
): { ok: true; note: string | null } | { ok: false; message: string } {
  const text = typeof note === 'string' ? note.trim().replace(/\s+/g, ' ') : '';
  if (!text.length) {
    return required
      ? { ok: false, message: `Add a note for the person, ${NOTE_MIN} to ${NOTE_MAX} characters.` }
      : { ok: true, note: null };
  }
  if (text.length < NOTE_MIN || text.length > NOTE_MAX) {
    return { ok: false, message: `The note must be ${NOTE_MIN} to ${NOTE_MAX} characters.` };
  }
  return { ok: true, note: text };
}

/** Every calendar day of a request. */
export function datesOf(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let d = startDate; d <= endDate; d = addDaysToKey(d, 1)) out.push(d);
  return out;
}

export interface DayInfo {
  date: string;
  /** A working day for this person (holidays and weekly days off are not). */
  workday: boolean;
  /** "Holiday: Diwali", "Weekly day off". */
  offLabel: string | null;
}

export interface PricedDay {
  date: string;
  mask: number;
  units: number;
}

/** The working days a request charges, and the days it skips (with why). */
export function priceDays(
  kind: LeaveKind,
  part: LeavePart | null,
  days: readonly DayInfo[],
): { charged: PricedDay[]; skipped: { date: string; why: string }[] } {
  const mask = maskOf(kind, part);
  const units = unitsOfMask(mask);
  const charged: PricedDay[] = [];
  const skipped: { date: string; why: string }[] = [];
  for (const d of days) {
    if (d.workday) charged.push({ date: d.date, mask, units });
    else skipped.push({ date: d.date, why: d.offLabel ?? 'Not a working day' });
  }
  return { charged, skipped };
}

/** Days of `wanted` that share a quarter with leave already held. */
export function overlapping(
  wanted: readonly { date: string; mask: number }[],
  held: readonly { date: string; mask: number }[],
): string[] {
  const byDate = new Map<string, number>();
  for (const h of held) byDate.set(h.date, (byDate.get(h.date) ?? 0) | h.mask);
  return wanted.filter((w) => ((byDate.get(w.date) ?? 0) & w.mask) !== 0).map((w) => w.date);
}
