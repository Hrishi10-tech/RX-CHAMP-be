import {
  CATEGORY_LABEL,
  FULL_MASK,
  kindLabel,
  LeaveCategory,
  PART_MASK,
  unitsOfMask,
} from './leave.types';
import { workingWindow } from './parts';

/**
 * A person's leave on one day, as the working-day views read it (3.4). Pure, so
 * the worktime and reports domains can use it without the leave module.
 */
export interface DayLeave {
  /** Quarters on approved leave (bits Q1 = 1 to Q4 = 8). */
  mask: number;
  /** Quarter days on approved leave (0 to 4). */
  units: number;
  clslUnits: number;
  elplUnits: number;
  /** Quarters asked for and still waiting for a decision. */
  pendingMask: number;
  /** The whole day is on approved leave. */
  full: boolean;
}

export const NO_LEAVE: Readonly<DayLeave> = Object.freeze({
  mask: 0,
  units: 0,
  clslUnits: 0,
  elplUnits: 0,
  pendingMask: 0,
  full: false,
});

/** userId -> date -> leave that day */
export type LeaveByDay = Map<string, Map<string, DayLeave>>;

export function leaveOn(map: LeaveByDay | undefined, userId: string, date: string): DayLeave {
  return map?.get(userId)?.get(date) ?? NO_LEAVE;
}

/** Expected seconds left once the leave is taken out (a half day halves it). */
export function expectedAfterLeave(expectedSec: number, leave: DayLeave | undefined): number {
  const units = Math.min(4, leave?.units ?? 0);
  return Math.round((expectedSec * (4 - units)) / 4);
}

/** Seconds of the shift's expected time the leave covers (paid leave time). */
export function leaveSecOf(expectedSec: number, leave: DayLeave | undefined): number {
  return expectedSec - expectedAfterLeave(expectedSec, leave);
}

/** Where the working part of the day starts and ends once the leave is taken out. */
export function shiftAfterLeave(
  start: Date | null,
  end: Date | null,
  leave: DayLeave | undefined,
): { start: Date | null; end: Date | null } {
  if (!start || !end || !leave || !leave.mask || leave.full) return { start, end };
  return workingWindow(start, end, leave.mask);
}

/** What the day's views say about the leave; null without any. */
export interface DayLeaveView {
  /** Days on approved leave that day (0.25 to 1). */
  days: number;
  full: boolean;
  /** "Full day", "Half day (first half)", "2nd quarter" for odd masks. */
  label: string;
  /** "CL/SL", "EL/PL" or "CL/SL + EL/PL". */
  categories: string;
  clslDays: number;
  elplDays: number;
  /** Quarters still waiting for a decision. */
  pendingDays: number;
  mask: number;
}

function partOfMask(mask: number): string {
  if ((mask & FULL_MASK) === FULL_MASK) return kindLabel('FULL_DAY', null);
  for (const part of ['FIRST_HALF', 'SECOND_HALF'] as const) {
    if (mask === PART_MASK[part]) return kindLabel('HALF_DAY', part);
  }
  for (const part of ['Q1', 'Q2', 'Q3', 'Q4'] as const) {
    if (mask === PART_MASK[part]) return kindLabel('QUARTER_DAY', part);
  }
  return `${unitsOfMask(mask)} quarters of the day`;
}

export function dayLeaveView(leave: DayLeave | undefined): DayLeaveView | null {
  if (!leave || (!leave.mask && !leave.pendingMask)) return null;
  const cats: LeaveCategory[] = [];
  if (leave.clslUnits) cats.push('CLSL');
  if (leave.elplUnits) cats.push('ELPL');
  return {
    days: leave.units / 4,
    full: leave.full,
    label: leave.mask ? partOfMask(leave.mask) : 'Waiting for approval',
    categories: cats.map((c) => CATEGORY_LABEL[c]).join(' + '),
    clslDays: leave.clslUnits / 4,
    elplDays: leave.elplUnits / 4,
    pendingDays: unitsOfMask(leave.pendingMask & ~leave.mask) / 4,
    mask: leave.mask,
  };
}
