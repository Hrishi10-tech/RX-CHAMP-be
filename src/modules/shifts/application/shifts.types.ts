import {
  ApproverRole,
  BreakApprovalStatus,
  BreakKind,
  BreakOutcome,
  BreakPresenceType,
  BreakTiming,
  ShiftRules,
  ShiftSource,
} from '../domain/shift.types';

/** All times are ISO-8601 instants; "HH:MM" fields are in the business timezone. */

export interface ShiftBreakView {
  kind: BreakKind;
  label: string;
  enabled: boolean;
  startTime: string;
  durationMin: number;
  windowBeforeMin: number;
  windowAfterMin: number;
  /** 3.1: whether staff may skip it (the shift editor toggle). */
  allowSkip: boolean;
  /** Derived "HH:MM" times for display. */
  endTime: string;
  windowOpen: string;
  windowClose: string;
  ringStart: string;
  ringEnd: string;
}

export interface ShiftView {
  id: string;
  companyId: string | null;
  name: string;
  start: string;
  end: string;
  /** True when the shift runs past midnight. */
  overnight: boolean;
  workDays: number[];
  isDefault: boolean;
  rules: ShiftRules;
  breaks: ShiftBreakView[];
  usage: {
    /** Active people this shift applies to today. */
    people: number;
    /** Departments whose shift it is today. */
    departments: string[];
    /** People on it through a personal override today. */
    overrides: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface ShiftValidationView {
  valid: boolean;
  /** Human-readable problems, in the order the editor shows them. */
  problems: string[];
  /** The breaks with their derived times (end, window, ring). */
  breaks: ShiftBreakView[];
}

export interface ShiftRef {
  id: string;
  name: string;
  start: string;
  end: string;
}

export interface DepartmentAssignmentView {
  department: string;
  departmentKey: string;
  companyId: string | null;
  /** Active people in the department. */
  people: number;
  /** The department's shift today (null = falls back to the default shift). */
  current: { shift: ShiftRef | null; effectiveFrom: string } | null;
  /** A change already scheduled for a later day. */
  upcoming: { shift: ShiftRef | null; effectiveFrom: string } | null;
  /** People in the department on a personal override today. */
  overrides: number;
}

export interface PersonShiftView {
  userId: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  designation: string | null;
  managerId: string | null;
  /** The shift that applies today, and why. */
  shift: ShiftRef | null;
  source: ShiftSource;
  /** The personal override in force today, if any. */
  override: {
    shift: ShiftRef | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  } | null;
  /** A personal change scheduled for a later day, if any. */
  upcoming: { shift: ShiftRef | null; effectiveFrom: string; effectiveTo: string | null } | null;
}

export interface BreakRecordView {
  id: string;
  date: string;
  kind: BreakKind | null;
  label: string;
  presenceType: BreakPresenceType;
  shiftName: string | null;
  scheduledStart: string | null;
  durationMin: number | null;
  startedAt: string;
  endedAt: string | null;
  inProgress: boolean;
  /** Seconds taken so far (running) or in total (finished). */
  tookSec: number;
  /** Seconds past the break's length (0 when within it). */
  overrunSec: number;
  timing: BreakTiming;
  minutesOff: number;
  reason: string | null;
  overrunReason: string | null;
  source: string;
  approvalStatus: BreakApprovalStatus;
  approverRole: ApproverRole | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedByName: string | null;
  /** 3.1: TAKEN, or a skip (no presence session; startedAt = when it was skipped). */
  outcome: BreakOutcome;
  /** 3.1: true when the person asked for the overrun to count as focus time. */
  overrunAsked: boolean;
  /** 3.1: when the comment on a skip was added (the comment is `reason`). */
  commentedAt: string | null;
  /** 3.1: when the decision is due (48-hour rule), while it is or was pending. */
  dueAt: string | null;
  /** 3.1: a skip with no reason that is still PENDING: the person must comment. */
  needsComment: boolean;
}

/** A skip that is still waiting for the person's comment (SPEC 3.1). */
export interface SkipNeedingComment {
  id: string;
  date: string;
  kind: BreakKind;
  label: string;
  outcome: 'SKIPPED' | 'AUTO_SKIPPED';
  skippedAt: string;
  scheduledStart: string | null;
  durationMin: number | null;
  minChars: number;
}

export interface BreakSlotView {
  kind: BreakKind;
  label: string;
  presenceType: BreakPresenceType;
  /** 3.1: whether the agent offers Skip break. */
  allowSkip: boolean;
  durationMin: number;
  scheduledStart: string;
  scheduledEnd: string;
  windowOpen: string;
  windowClose: string;
  ringStart: string;
  ringEnd: string;
  local: {
    start: string;
    end: string;
    windowOpen: string;
    windowClose: string;
    ringStart: string;
    ringEnd: string;
  };
  /** The break as taken today, or null. */
  record: BreakRecordView | null;
}

/**
 * What the agent needs for the day. mode SCHEDULED: follow the break slots
 * (ring, windows, reasons). mode FREE: no schedule today (no shift, a day off or
 * a shift without breaks), so break and lunch work the old way.
 */
export interface MyBreakDayView {
  date: string;
  serverNow: string;
  timezone: string;
  mode: 'SCHEDULED' | 'FREE';
  workday: boolean;
  /** The person pressed End Day: no break can start until tomorrow. */
  dayEnded: boolean;
  shift: (ShiftRef & { rules: ShiftRules }) | null;
  source: ShiftSource;
  breaks: BreakSlotView[];
  /** Breaks that matched no slot (started by older agents). */
  unscheduled: BreakRecordView[];
  /** The break running right now, if any. */
  activeBreak: BreakRecordView | null;
}

/** GET /breaks/me/today in 3.1: the day view plus what the End Day dialog needs. */
export interface BreakDayView extends MyBreakDayView {
  /** Skips from the last 31 days still waiting for a comment, newest first. */
  skipsNeedingComment: SkipNeedingComment[];
  /** Minimum length of a skip reason or comment today. */
  reasonMinChars: number;
}

export interface StartBreakResult {
  record: BreakRecordView;
  presence: {
    status: BreakPresenceType;
    sessionId: string;
    note: null;
    since: string;
    elapsedSec: number;
  };
}

export interface EndBreakResult {
  ended: boolean;
  record: BreakRecordView | null;
}

export interface MyBreakHistoryView {
  from: string;
  to: string;
  items: BreakRecordView[];
}

export interface ApprovalPersonView {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
}

export interface ApprovalItemView extends BreakRecordView {
  user: ApprovalPersonView;
  /** Whether the caller may decide this one (false for read-only rows). */
  canDecide: boolean;
}

export interface ApprovalsSummaryView {
  date: string;
  pendingToday: number;
  overdue: number;
  approvedToday: number;
  rejectedToday: number;
}

export interface BulkApproveResult {
  approved: string[];
  skipped: { id: string; reason: string }[];
}

export type TeamCellStatus =
  | 'UPCOMING'
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'TAKEN'
  | 'SKIPPED'
  | 'AUTO_SKIPPED'
  | 'MISSED';

export interface TeamBreakCellView {
  kind: BreakKind;
  label: string;
  localStart: string;
  status: TeamCellStatus;
  record: BreakRecordView | null;
}

export interface TeamBreakRowView {
  user: ApprovalPersonView;
  shift: ShiftRef | null;
  source: ShiftSource;
  workday: boolean;
  cells: TeamBreakCellView[];
  unscheduled: BreakRecordView[];
  pending: number;
}

export interface TeamBreaksView {
  date: string;
  rows: TeamBreakRowView[];
  totals: {
    people: number;
    taken: number;
    late: number;
    early: number;
    missed: number;
    overrun: number;
    pending: number;
    /** 3.1: skipped and auto-skipped breaks (not counted in `taken`). */
    skipped: number;
  };
}
