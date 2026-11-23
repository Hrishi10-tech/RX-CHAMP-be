import type { DayLeaveView } from '@modules/leave/domain/day-leave';
import { BreakRecordView } from '@modules/shifts/application/shifts.types';
import { BreakKind } from '@modules/shifts/domain/shift.types';
import {
  ApprovalItemView,
  FocusAdjustmentView,
  MeetingRecordView,
} from '@modules/worktime/application/worktime.types';
import { DayClass } from '@modules/worktime/domain/attendance';
import { HourActivity } from '@modules/worktime/domain/hourly';
import type { PendingBlocker } from '@modules/worktime/domain/approvals.reader';
import type { OpenSessionBlocker, PendingLeaveBlocker, PendingWfhBlocker } from './report.store';

/** Report shapes (SPEC 3.7). */

export interface ReportPerson {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  designation: string | null;
  /** 4.0: the person's department (absent in snapshots locked before 4.0). */
  departmentId?: string | null;
  /** 3.x reporting line, kept for older readers; not used for scope in 4.0. */
  managerId: string | null;
  managerName: string | null;
}

export interface PersonDaySummary {
  date: string;
  /** ISO weekday 1 (Mon) .. 7 (Sun). */
  weekday: number;
  workday: boolean;
  dayClass: DayClass;
  startedAt: string | null;
  endedAt: string | null;
  autoClosed: boolean;
  /** 4.1 shared computer: the day was carried on into the next shift. */
  extended?: boolean;
  /** 4.1: how long the extended day ran past the shift end. */
  extendedSec?: number;
  /** Minutes after the shift start plus the grace, and why (3.2; null until given). */
  lateStart: { minutes: number; reason?: string | null } | null;
  /** A holiday (with its name) or a weekly day off (3.2); null on a working day. */
  dayOff?: { kind: 'HOLIDAY' | 'WEEKLY_OFF'; name: string | null } | null;
  focusSec: number;
  expectedSec: number;
  /** 3.6: the day's target with future working days included (expectedSec is 0 on those). Absent on a month locked before 3.6. */
  plannedSec?: number;
  breakSec: number;
  meetingSec: number;
  approvedPlusSec: number;
  rejectedMinusSec: number;
  pendingPlusSec: number;
  pendingMinusSec: number;
  breaksTaken: number;
  skipped: number;
  autoSkipped: number;
  overruns: number;
  meetings: number;
  pending: number;
  quietHours: number;
  activeMin: number;
  // ---- 4.0 (docs/4.0/SPEC.md 2.4, 5.8)
  /** The calendar's label for the date (a holiday), or null. */
  label: string | null;
  /** The day's focus target (= expectedSec). */
  targetSec: number;
  paidBreakSec: number;
  unpaidBreakSec: number;
  awayApprovedSec: number;
  awayPendingSec: number;
  awayRejectedSec: number;
  awayUnexplainedSec: number;
  /** Offline time with no activity data (REPLAY sessions the agent's samples do not cover). */
  unverifiedSec: number;
  /** Payroll time: focusSec + paidBreakSec. */
  paidSec: number;
  /**
   * 3.3: signed seconds added to focus by hand (Super Manager), already inside
   * focusSec and paidSec; 0 on an untouched day, absent from older snapshots.
   */
  adjustedSec?: number;
  /** Seconds with keyboard or mouse input inside the working day (3.2 Fix 10). */
  activeSec?: number;
  /** Seconds inside the working day not on a break or in a meeting (3.2 Fix 10). */
  availableSec?: number;
  /** Leave that day (3.4): approved, and any still waiting; null without any. */
  leave?: DayLeaveView | null;
  /** Expected seconds the approved leave covers: paid leave time (3.4). */
  leaveSec?: number;
  /** Work from home approved that day, in days (3.5). */
  wfhDays?: number;
  /** Time worked from home on the phone that counted, and beyond the cap (3.5). */
  wfhSec?: number;
  wfhOverSec?: number;
  /** Comp off approved for working this day (3.5). */
  compOffEarnedDays?: number;
  /** A biometric day closed with no check-out (3.5). */
  noCheckout?: boolean;
  /**
   * 3.6: seconds nobody was at the computer, outside breaks and meetings; null when no agent
   * reported on the day. The team day and a month's worked days; absent elsewhere.
   */
  idleSec?: number | null;
  /**
   * 3.6: this day's payroll is not calculated (biometric staff, the integration off): no
   * paid time. Absent on every other day. Tracking and focus time stay as they are.
   */
  payrollPaused?: boolean;
}

export interface TimelineSegment {
  kind: 'WORK' | 'BREAK' | 'LUNCH' | 'MEETING' | 'OFF';
  startedAt: string;
  endedAt: string;
  label: string;
}

export interface PersonDayReport {
  person: ReportPerson;
  summary: PersonDaySummary;
  shift: { id: string; name: string; start: string; end: string } | null;
  timeline: TimelineSegment[];
  skips: { at: string; kind: BreakKind; label: string; outcome: 'SKIPPED' | 'AUTO_SKIPPED' }[];
  breaks: BreakRecordView[];
  meetings: MeetingRecordView[];
  approvals: ApprovalItemView[];
  hourly: HourActivity[];
  /** 3.3: the day's manual focus adjustments, newest first, voided ones included. */
  adjustments?: FocusAdjustmentView[];
  /**
   * The day's keyboard and mouse input inside the available time (sessions minus
   * breaks and meetings), Fix 10: active, idle (nobody at the computer, a lock),
   * and no data (the agent was not reporting). Null when it could not be read.
   */
  input?: { activeSec: number; idleSec: number; noDataSec: number; availableSec: number } | null;
  /**
   * A biometric person's punches of the day (3.5), oldest first, voided ones
   * included; [] for a day recorded by the desktop app.
   */
  punches?: DayPunchView[];
}

/** One punch as the day pages show it (3.5). */
export interface DayPunchView {
  at: string;
  direction: 'IN' | 'OUT' | null;
  deviceId: string;
  /** PUSH, PULL, CSV or MANUAL. */
  source: string;
  voided: boolean;
}

export interface MonthTotals {
  workdays: number;
  full: number;
  half: number;
  absent: number;
  off: number;
  extra: number;
  focusSec: number;
  expectedSec: number;
  /** 3.6: the whole month's target, future working days included. Absent on a month locked before 3.6. */
  plannedSec?: number;
  avgFocusSec: number;
  lateStarts: number;
  /** Late starts still without a reason (3.2). */
  lateWithoutReason?: number;
  /** Holidays in the month (3.2). */
  holidays?: number;
  skipped: number;
  autoSkipped: number;
  overruns: number;
  meetings: number;
  approvedPlusSec: number;
  rejectedMinusSec: number;
  pending: number;
  quietHours: number;
  /** Keyboard and mouse input inside working days (Fix 10). */
  activeSec?: number;
  availableSec?: number;
  /** Full days of leave not worked (day class LEAVE, 3.4). */
  leave?: number;
  /** Days of approved leave so far, part days included, and per pool (3.4). */
  leaveDays?: number;
  clslDays?: number;
  elplDays?: number;
  /** Comp off taken, and earned (approved for days worked) in the month (3.5). */
  compOffDays?: number;
  compOffEarnedDays?: number;
  /** Days of work from home, time from home beyond the cap, biometric days with no check-out (3.5). */
  wfhDays?: number;
  wfhOverSec?: number;
  noCheckoutDays?: number;
  /** Paid leave time: the expected time the leave covers (3.4). */
  leaveSec?: number;
  /**
   * The month's idle time, the sum of its days by the same rule as one day (3.6); null when no
   * agent reported on any of them. Absent on a month locked before it was kept.
   */
  idleSec?: number | null;
  needsALook: boolean;
  // ---- 4.0
  /** Sum of every day's target (future working days included). */
  targetSec: number;
  breakSec: number;
  meetingSec: number;
  paidBreakSec: number;
  unpaidBreakSec: number;
  awayApprovedSec: number;
  awayPendingSec: number;
  /** Offline time with no activity data (absent from snapshots taken before it existed). */
  unverifiedSec: number;
  /** Payroll time: focusSec + paidBreakSec (absent from snapshots taken before it existed). */
  paidSec: number;
  /** 3.3: signed seconds added to focus by hand over the month (already inside focusSec). */
  adjustedSec?: number;
}

/**
 * A person's payroll standing for the month (3.6): present only when some day of it is
 * paused. `totals` are what payroll counts: the days calculated, with the paused ones left out.
 */
export interface PersonPayroll {
  /** Every day so far is paused: the person is left out of payroll altogether. */
  paused: boolean;
  /** "Payroll paused · biometric integration pending". */
  label: string;
  /** Days so far whose payroll is not calculated, and the first and last of them. */
  pausedDays: number;
  pausedFrom: string;
  pausedTo: string;
  totals: MonthTotals;
}

export interface PersonMonthReport {
  person: ReportPerson;
  month: string;
  locked: boolean;
  generatedAt: string;
  totals: MonthTotals;
  days: PersonDaySummary[];
  /** Active minutes per hour 0..23, per day. */
  heatmap: { date: string; hours: number[] }[];
  /** 3.6: set when some day of the month is paused (biometric staff). */
  payroll?: PersonPayroll;
}

export interface TeamMonthRow {
  person: ReportPerson;
  totals: MonthTotals;
  days: { date: string; dayClass: DayClass; focusSec: number }[];
  /** 3.6: set when some day of the month is paused (biometric staff). */
  payroll?: PersonPayroll;
}

export interface TeamMonthReport {
  month: string;
  scope: 'TEAM' | 'ALL';
  locked: boolean;
  generatedAt: string;
  /** What payroll counts: every row's calculated days (3.6: paused days and people left out). */
  totals: MonthTotals & { people: number };
  /** Everyone in `rows` as tracked, paused days and people included (3.6). */
  trackedTotals: MonthTotals & { people: number };
  rows: TeamMonthRow[];
}

export interface TeamDayReport {
  date: string;
  rows: { person: ReportPerson; summary: PersonDaySummary }[];
}

/** What a month lock stores: the everyone report, plus each person's month. */
export interface MonthSnapshot {
  version: 1;
  generatedAt: string;
  team: TeamMonthReport;
  persons: Record<string, PersonMonthReport>;
  /**
   * 3.6: biometric staff with nothing calculated this month: not part of the payroll run,
   * kept apart so their reports still show them, labelled. Absent when there are none.
   */
  payrollPaused?: Record<string, PersonMonthReport>;
}

export interface MonthLockView {
  month: string;
  locked: boolean;
  lockedAt: string | null;
  lockedByName: string | null;
  pending: number;
  /**
   * What keeps the month from being locked, so the portal can name it instead of
   * only counting it: the undecided items (oldest day first, at most 50, in the
   * caller's scope) and the working days still open (Super Admin only).
   */
  blockers: MonthLockBlockers;
}

export interface MonthLockBlockers {
  items: PendingBlocker[];
  /** True when there are more undecided items than `items` lists. */
  moreItems: boolean;
  openSessions: OpenSessionBlocker[];
  /** Leave requests with a day in the month still waiting for a decision (3.4). */
  leave?: PendingLeaveBlocker[];
  /** How many there are (the list stops at 50). */
  pendingLeave?: number;
  /** Work-from-home requests with a day in the month still waiting (3.5). */
  wfh?: PendingWfhBlocker[];
  pendingWfh?: number;
}

export interface ReportRunView {
  id: string;
  month: string;
  scope: 'TEAM' | 'ALL';
  generatedAt: string;
  summary: Record<string, unknown>;
}
