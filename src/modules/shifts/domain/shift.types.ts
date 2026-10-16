/**
 * Shift and break domain types. Pure data: no Nest, no Prisma.
 */

export type BreakKind = 'MORNING' | 'LUNCH' | 'EVENING';

export const BREAK_KINDS: BreakKind[] = ['MORNING', 'LUNCH', 'EVENING'];

export const BREAK_LABEL: Record<BreakKind, string> = {
  MORNING: 'Morning break',
  LUNCH: 'Lunch break',
  EVENING: 'Evening break',
};

/** Which presence status a break puts the person in (what totals and boards show). */
export const BREAK_PRESENCE_TYPE: Record<BreakKind, BreakPresenceType> = {
  MORNING: 'BREAK',
  LUNCH: 'LUNCH',
  EVENING: 'BREAK',
};

export type BreakPresenceType = 'BREAK' | 'LUNCH';

export type BreakTiming = 'ON_TIME' | 'EARLY' | 'LATE' | 'OUTSIDE_WINDOW' | 'UNSCHEDULED';

export type BreakApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

/** 3.1: what became of a scheduled break. */
export type BreakOutcome = 'TAKEN' | 'SKIPPED' | 'AUTO_SKIPPED';

export const SKIP_OUTCOMES: BreakOutcome[] = ['SKIPPED', 'AUTO_SKIPPED'];

/** Shift defaults that 3.1 code falls back on when a record's shift is gone. */
export const DEFAULT_REASON_MIN_CHARS = 10;
export const DEFAULT_OVERRUN_GRACE_MIN = 3;

/** Morning and evening breaks can be skipped unless the shift says not; lunch cannot. */
export function defaultAllowSkip(kind: BreakKind): boolean {
  return kind !== 'LUNCH';
}

export type ShiftSource = 'OVERRIDE' | 'DEPARTMENT' | 'DEFAULT' | 'NONE';

export type AssignmentTarget = 'DEPARTMENT' | 'USER';

export type ApproverRole = 'SUPER_ADMIN' | 'MANAGER';

export interface ShiftBreakDef {
  kind: BreakKind;
  enabled: boolean;
  /** "HH:MM" local business time. */
  startTime: string;
  durationMin: number;
  windowBeforeMin: number;
  windowAfterMin: number;
  /** 3.1: may staff skip it? Absent means the kind's default (see defaultAllowSkip). */
  allowSkip?: boolean;
}

/** Whether a break may be skipped, applying the kind's default when unset. */
export function breakAllowsSkip(b: Pick<ShiftBreakDef, 'kind' | 'allowSkip'>): boolean {
  return b.allowSkip ?? defaultAllowSkip(b.kind);
}

export interface ShiftRules {
  ringLeadMin: number;
  ringDurationMin: number;
  ringSound: boolean;
  reasonOnEarly: boolean;
  reasonOnLate: boolean;
  reasonMinChars: number;
  overrunReason: boolean;
  overrunGraceMin: number;
}

export interface ShiftDefinition extends ShiftRules {
  name: string;
  /** "HH:MM"; end <= start means the shift runs past midnight. */
  start: string;
  end: string;
  /** ISO weekdays 1 (Mon) .. 7 (Sun). */
  workDays: number[];
  breaks: ShiftBreakDef[];
}

export interface ShiftRecord extends ShiftDefinition {
  id: string;
  companyId: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ShiftAssignmentRecord {
  id: string;
  target: AssignmentTarget;
  companyId: string | null;
  department: string | null;
  departmentKey: string | null;
  userId: string | null;
  /** Null on a USER row = back to the department's shift. */
  shiftId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdById: string | null;
  createdAt: Date;
}

/** One scheduled break of one shift on one shift-day, as absolute instants. */
export interface BreakSlot {
  kind: BreakKind;
  label: string;
  presenceType: BreakPresenceType;
  durationMin: number;
  scheduledStart: Date;
  scheduledEnd: Date;
  windowOpen: Date;
  windowClose: Date;
  ringStart: Date;
  ringEnd: Date;
  /** 3.1: whether staff may skip this break. */
  allowSkip: boolean;
}

/** Normalises a department name for matching ("  Sales  Team" -> "sales team"). */
export function departmentKey(department: string | null | undefined): string | null {
  const key = (department ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return key.length ? key : null;
}
