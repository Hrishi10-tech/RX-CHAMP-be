import { addDaysToKey } from '@shared/utils/timezone';
import { isWorkDay, shiftBounds } from './break-schedule';
import { ShiftRecord } from './shift.types';

export interface PickedShift {
  shift: ShiftRecord;
  /** The shift-day it belongs to (yesterday for an overnight shift still running). */
  dateKey: string;
}

/**
 * 4.1: which of a department's shifts a person gets when they press Start Day at `at`.
 *
 *   1. A shift on now: that one (several overlapping: the one that started last).
 *   2. In a gap: the next one to start today (they started early).
 *   3. After the last shift of the day: the one that ended most recently.
 *
 * Only shifts that work that day count; an overnight shift from yesterday that is
 * still running counts for yesterday. Null when none works today or yesterday.
 */
export function pickShiftByTime(
  options: ShiftRecord[],
  at: Date,
  todayKey: string,
  tz: string,
): PickedShift | null {
  const yesterday = addDaysToKey(todayKey, -1);
  const windows: { shift: ShiftRecord; dateKey: string; start: number; end: number }[] = [];
  for (const shift of options) {
    for (const dateKey of [yesterday, todayKey]) {
      if (!isWorkDay(shift, dateKey)) continue;
      const b = shiftBounds(shift, dateKey, tz);
      // Yesterday's shift only matters while it is still running (overnight).
      if (dateKey === yesterday && b.end.getTime() <= at.getTime()) continue;
      windows.push({ shift, dateKey, start: b.start.getTime(), end: b.end.getTime() });
    }
  }
  const t = at.getTime();
  const on = windows.filter((w) => w.start <= t && t < w.end).sort((a, b) => b.start - a.start);
  if (on[0]) return { shift: on[0].shift, dateKey: on[0].dateKey };
  const next = windows
    .filter((w) => w.dateKey === todayKey && w.start > t)
    .sort((a, b) => a.start - b.start);
  if (next[0]) return { shift: next[0].shift, dateKey: next[0].dateKey };
  const ended = windows.filter((w) => w.end <= t).sort((a, b) => b.end - a.end);
  return ended[0] ? { shift: ended[0].shift, dateKey: ended[0].dateKey } : null;
}
