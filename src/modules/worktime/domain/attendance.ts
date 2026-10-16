import { hmToMinutes, isValidHm, isoWeekdayOfKey } from '@shared/utils/timezone';

/**
 * Attendance (SPEC 1.9), as pure functions.
 *
 *   expectedSec = shift length − enabled scheduled break lengths (no shift: 8h)
 *   day class   = FULL ≥ fullDayPct% of expected, HALF ≥ halfDayPct%, else ABSENT,
 *                 on a working day; OFF or EXTRA on a day off; IN_PROGRESS today;
 *                 UPCOMING in the future
 *   late start  = first Start Day more than lateStartGraceMin after the shift start
 */

export type DayClass = 'FULL' | 'HALF' | 'ABSENT' | 'OFF' | 'EXTRA' | 'IN_PROGRESS' | 'UPCOMING';

export const NO_SHIFT_EXPECTED_SEC = 8 * 60 * 60;

/** Working days assumed for someone with no shift at all (the shift default). */
export const NO_SHIFT_WORK_DAYS = [1, 2, 3, 4, 5, 6];

export interface ShiftForAttendance {
  start: string;
  end: string;
  workDays: number[];
  breaks: { enabled: boolean; durationMin: number }[];
}

/** Shift length minus its enabled breaks, in seconds (no shift: 8h). */
export function expectedSecOf(shift: ShiftForAttendance | null): number {
  if (!shift || !isValidHm(shift.start) || !isValidHm(shift.end)) return NO_SHIFT_EXPECTED_SEC;
  let lengthMin = hmToMinutes(shift.end) - hmToMinutes(shift.start);
  if (lengthMin <= 0) lengthMin += 1440;
  const breaksMin = shift.breaks
    .filter((b) => b.enabled)
    .reduce((sum, b) => sum + Math.max(0, b.durationMin), 0);
  return Math.max(0, (lengthMin - breaksMin) * 60);
}

/** Whether `dateKey` is a working day (no shift: Monday to Saturday). */
export function isWorkdayFor(shift: Pick<ShiftForAttendance, 'workDays'> | null, dateKey: string) {
  const days = shift ? shift.workDays : NO_SHIFT_WORK_DAYS;
  return days.includes(isoWeekdayOfKey(dateKey));
}

export interface DayClassInput {
  date: string;
  today: string;
  workday: boolean;
  /** Time inside work sessions that day (> 0 means they worked). */
  spanSec: number;
  focusSec: number;
  expectedSec: number;
  fullDayPct: number;
  halfDayPct: number;
}

export function dayClassOf(i: DayClassInput): DayClass {
  if (i.date > i.today) return 'UPCOMING';
  if (i.date === i.today) return 'IN_PROGRESS';
  if (!i.workday) return i.spanSec > 0 ? 'EXTRA' : 'OFF';
  if (i.expectedSec <= 0) return i.focusSec > 0 ? 'FULL' : 'ABSENT';
  // Integer comparison, so the 80% / 40% boundaries are exact.
  if (i.focusSec * 100 >= i.expectedSec * i.fullDayPct) return 'FULL';
  if (i.focusSec * 100 >= i.expectedSec * i.halfDayPct) return 'HALF';
  return 'ABSENT';
}

/**
 * Minutes late, or null when on time. Whole minutes after the shift start (floor);
 * late only when that is more than the grace.
 */
export function lateStartOf(
  firstStart: Date | null,
  shiftStart: Date | null,
  graceMin: number,
): { minutes: number } | null {
  if (!firstStart || !shiftStart) return null;
  const minutes = Math.floor((firstStart.getTime() - shiftStart.getTime()) / 60_000);
  return minutes > graceMin ? { minutes } : null;
}
