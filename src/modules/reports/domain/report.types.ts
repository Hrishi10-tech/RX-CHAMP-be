import { BreakRecordView } from '@modules/shifts/application/shifts.types';
import { BreakKind } from '@modules/shifts/domain/shift.types';
import { ApprovalItemView, MeetingRecordView } from '@modules/worktime/application/worktime.types';
import { DayClass } from '@modules/worktime/domain/attendance';
import { HourActivity } from '@modules/worktime/domain/hourly';

/** Report shapes (SPEC 3.7). */

export interface ReportPerson {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  designation: string | null;
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
  lateStart: { minutes: number } | null;
  focusSec: number;
  expectedSec: number;
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
  avgFocusSec: number;
  lateStarts: number;
  skipped: number;
  autoSkipped: number;
  overruns: number;
  meetings: number;
  approvedPlusSec: number;
  rejectedMinusSec: number;
  pending: number;
  quietHours: number;
  needsALook: boolean;
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
}

export interface TeamMonthRow {
  person: ReportPerson;
  totals: MonthTotals;
  days: { date: string; dayClass: DayClass; focusSec: number }[];
}

export interface TeamMonthReport {
  month: string;
  scope: 'TEAM' | 'ALL';
  locked: boolean;
  generatedAt: string;
  totals: MonthTotals & { people: number };
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
}

export interface MonthLockView {
  month: string;
  locked: boolean;
  lockedAt: string | null;
  lockedByName: string | null;
  pending: number;
}

export interface ReportRunView {
  id: string;
  month: string;
  scope: 'TEAM' | 'ALL';
  generatedAt: string;
  summary: Record<string, unknown>;
}
