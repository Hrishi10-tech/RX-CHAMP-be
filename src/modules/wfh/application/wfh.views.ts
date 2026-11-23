import { DeciderRole } from '@modules/leave/domain/routing';
import { LeaveKind, LeavePart, LeaveStatus } from '@modules/leave/domain/leave.types';

/** What the API answers about work from home (3.5). Amounts in days (0.25 steps). */

export interface WfhRequestView {
  id: string;
  userId: string;
  userName: string;
  /** The person's effective avatar (3.6). */
  avatarId: string | null;
  department: string | null;
  companyId: string | null;
  companyName: string | null;
  /** How the person's day is recorded: the desktop app, or biometric (then the phone). */
  attendanceSource: 'AGENT' | 'BIOMETRIC';
  kind: LeaveKind;
  part: LeavePart | null;
  kindLabel: string;
  startDate: string;
  endDate: string;
  span: string;
  days: number;
  daysLabel: string;
  dates: { date: string; label: string; days: number }[];
  /** Part days: when on the shift, "09:30 to 14:00". */
  partTimes: string | null;
  reason: string;
  status: LeaveStatus;
  statusLabel: string;
  approverRole: DeciderRole | null;
  waitingFor: string | null;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  can: { cancel: boolean; decide: boolean; revoke: boolean };
}

export interface WfhPreview {
  ok: boolean;
  problem: { field: string; code: string; message: string } | null;
  kind: LeaveKind | null;
  part: LeavePart | null;
  startDate: string | null;
  endDate: string | null;
  dates: { date: string; label: string; covered: boolean; days: number; why: string | null }[];
  days: number;
  daysLabel: string;
  partTimes: string | null;
  waitingFor: string | null;
  approvedAtOnce: boolean;
  /** How the day is tracked, in a sentence for the form. */
  tracking: string;
  /** Biometric staff: the most a full day of the first covered day credits (seconds). */
  capPerDaySec: number | null;
}

export interface WfhScheduleView {
  id: string;
  userId: string;
  userName: string;
  /** The person's effective avatar (3.6). */
  avatarId: string | null;
  department: string | null;
  companyName: string | null;
  weekdays: number[];
  weeks: number[];
  kind: LeaveKind;
  part: LeavePart | null;
  /** "Every Wednesday, full day" */
  label: string;
  fromDate: string;
  toDate: string | null;
  skipDates: string[];
  note: string;
  /** In force today, ahead, or over. */
  state: 'ACTIVE' | 'UPCOMING' | 'ENDED';
  /** The next few days it covers (working days only). */
  next: { date: string; label: string }[];
  createdByName: string;
  updatedAt: string;
  can: { edit: boolean };
}

/** GET /wfh/me */
export interface MyWfhView {
  today: string;
  attendanceSource: 'AGENT' | 'BIOMETRIC';
  /** Today: approved work from home, or null. */
  todayWfh: { days: number; label: string; source: string; capSec: number } | null;
  upcoming: WfhRequestView[];
  requests: WfhRequestView[];
  schedules: WfhScheduleView[];
  /** Days from home this month (approved and scheduled, working days so far and ahead). */
  thisMonth: { days: number; waitingDays: number; capDays: number | null };
  waitingFor: string | null;
  policy: unknown;
}
