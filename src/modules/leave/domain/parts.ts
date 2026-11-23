import { hmToMinutes, isValidHm, minutesToHm } from '@shared/utils/timezone';
import { leadingQuarters, trailingQuarters, UNITS_PER_DAY } from './leave.types';

/**
 * Where a part-day leave sits in the shift (3.4). A quarter is a quarter of the
 * shift, start to end (breaks inside it included), so a 09:30 to 18:30 shift has
 * quarters 09:30, 11:45, 14:00 and 16:15. Pure.
 */

/** Shift length in minutes; an overnight shift runs past midnight. */
function shiftMinutes(startHm: string, endHm: string): { start: number; length: number } | null {
  if (!isValidHm(startHm) || !isValidHm(endHm)) return null;
  const start = hmToMinutes(startHm);
  let end = hmToMinutes(endHm);
  if (end <= start) end += 24 * 60;
  return { start, length: end - start };
}

/** "09:30 to 14:00" for a contiguous mask on this shift; null for a full day or no shift. */
export function partClock(
  startHm: string | null,
  endHm: string | null,
  mask: number,
): string | null {
  if (!startHm || !endHm) return null;
  const s = shiftMinutes(startHm, endHm);
  if (!s) return null;
  let first = -1;
  let last = -1;
  for (let q = 0; q < UNITS_PER_DAY; q += 1) {
    if (mask & (1 << q)) {
      if (first < 0) first = q;
      last = q;
    }
  }
  if (first < 0 || (first === 0 && last === UNITS_PER_DAY - 1)) return null;
  const at = (q: number) =>
    minutesToHm((s.start + Math.round((s.length * q) / UNITS_PER_DAY)) % 1440);
  return `${at(first)} to ${at(last + 1)}`;
}

/**
 * The working window left on a part-leave day, as instants: leave at the start
 * moves the start (the late-start mark follows it), leave at the end moves the end.
 */
export function workingWindow(
  shiftStart: Date,
  shiftEnd: Date,
  mask: number,
): { start: Date; end: Date } {
  const length = shiftEnd.getTime() - shiftStart.getTime();
  const lead = leadingQuarters(mask);
  const trail = lead >= UNITS_PER_DAY ? 0 : trailingQuarters(mask);
  const quarter = length / UNITS_PER_DAY;
  return {
    start: new Date(shiftStart.getTime() + Math.round(quarter * lead)),
    end: new Date(shiftEnd.getTime() - Math.round(quarter * trail)),
  };
}
