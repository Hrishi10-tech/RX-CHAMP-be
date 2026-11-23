import { hmToMinutes, isValidHm, isoWeekdayOfKey } from '@shared/utils/timezone';

/**
 * Attendance (SPEC 1.9), as pure functions.
 *
 *   expectedSec = shift length − enabled scheduled break lengths (no shift: 8h)
 *   day class   = FULL ≥ fullDayPct% of expected, HALF ≥ halfDayPct%, else ABSENT,
 *                 on a working day; OFF or EXTRA on a day off; IN_PROGRESS today;
 *                 UPCOMING in the future; LEAVE on a full day of approved leave
 *                 not worked (3.4; worked anyway, it is EXTRA)
 *   late start  = first Start Day more than lateStartGraceMin after the shift start
 *                 (3.4: after the end of leave at the start of the day)
 *
 * Part-day leave reduces the expected time first (a half day halves it), so the
 * day is judged on the rest; see expectedAfterLeave.
 */

export type DayClass =
  | 'FULL'
  | 'HALF'
  | 'ABSENT'
  | 'OFF'
  | 'EXTRA'
  | 'LEAVE'
  | 'IN_PROGRESS'
  | 'UPCOMING';

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

/** Shift length in seconds (no or invalid shift: 8 h). */
export function shiftLengthSecOf(shift: Pick<ShiftForAttendance, 'start' | 'end'> | null): number {
  if (!shift || !isValidHm(shift.start) || !isValidHm(shift.end)) return NO_SHIFT_EXPECTED_SEC;
  let lengthMin = hmToMinutes(shift.end) - hmToMinutes(shift.start);
  if (lengthMin <= 0) lengthMin += 1440;
  return lengthMin * 60;
}

/** Minutes of the shift's enabled scheduled breaks (e.g. 20 + 40 + 20 = 80). */
export function scheduledBreakMinOf(shift: Pick<ShiftForAttendance, 'breaks'> | null): number {
  if (!shift) return 0;
  return shift.breaks
    .filter((b) => b.enabled)
    .reduce((sum, b) => sum + Math.max(0, b.durationMin), 0);
}

/**
 * 4.0 (docs/4.0/SPEC.md 2.4): the paid break allowance and the day's focus target.
 *
 *   allowanceSec = (scheduledMin + bufferMin) · 60
 *   targetSec    = isWorkingDay ? max(0, shiftLengthSec − allowanceSec) : 0
 *
 * A 9-hour shift with 20 + 40 + 20 min of breaks and a 10 min buffer: 1 h 30 m
 * paid allowance and a 7 h 30 m target. No shift: 8 h minus the buffer.
 */
export function allowanceOf(
  shift: ShiftForAttendance | null,
  bufferMin: number,
): { scheduledSec: number; bufferSec: number; totalSec: number; shiftLengthSec: number } {
  const scheduledSec = scheduledBreakMinOf(shift) * 60;
  const bufferSec = Math.max(0, Math.round(bufferMin * 60));
  return {
    scheduledSec,
    bufferSec,
    totalSec: scheduledSec + bufferSec,
    shiftLengthSec: shiftLengthSecOf(shift),
  };
}

export function targetSecOf(
  shift: ShiftForAttendance | null,
  bufferMin: number,
  isWorkingDay: boolean,
): number {
  if (!isWorkingDay) return 0;
  const a = allowanceOf(shift, bufferMin);
  return Math.max(0, a.shiftLengthSec - a.totalSec);
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
  /** Expected time left after any part-day leave (expectedAfterLeave). */
  expectedSec: number;
  fullDayPct: number;
  halfDayPct: number;
  /** The whole day is on approved leave (3.4). */
  fullLeave?: boolean;
}

export function dayClassOf(i: DayClassInput): DayClass {
  // A day of leave is leave whenever it is (past, today or ahead), unless worked.
  if (i.workday && i.fullLeave && i.spanSec <= 0) return 'LEAVE';
  if (i.date > i.today) return 'UPCOMING';
  if (i.date === i.today) return 'IN_PROGRESS';
  if (!i.workday) return i.spanSec > 0 ? 'EXTRA' : 'OFF';
  if (i.fullLeave) return 'EXTRA';
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

/** Longest late-start reason kept (longer is refused). */
export const LATE_REASON_MAX_CHARS = 500;

export interface LateStartDetail {
  minutes: number;
  /** Minutes allowed without a reason (the setting). */
  graceMin: number;
  /** Why they started late, once given (agent or portal). */
  reason: string | null;
  reasonAt: string | null;
  /** A reason is asked for and none was given yet. */
  needsReason: boolean;
}

/**
 * The late start of a day with its reason (3.2). Late when the first Start Day came
 * more than `graceMin` minutes after the shift start; a reason is then asked for
 * unless the setting is off or the person reports to nobody (a Super Admin).
 */
export function lateStartDetail(input: {
  first: { startedAt: Date; lateReason?: string | null; lateReasonAt?: Date | null } | null;
  shiftStart: Date | null;
  graceMin: number;
  requireReason: boolean;
  exempt?: boolean;
}): LateStartDetail | null {
  if (!input.first) return null;
  const late = lateStartOf(input.first.startedAt, input.shiftStart, input.graceMin);
  if (!late) return null;
  const reason = input.first.lateReason?.trim() ? input.first.lateReason.trim() : null;
  return {
    minutes: late.minutes,
    graceMin: input.graceMin,
    reason,
    reasonAt: reason && input.first.lateReasonAt ? input.first.lateReasonAt.toISOString() : null,
    needsReason: input.requireReason && !input.exempt && !reason,
  };
}
