import { ApproverRoute } from '../domain/leave-policy';
import { DeciderRole } from '../domain/routing';
import { LeaveCategory, LeaveKind, LeavePart, LeaveStatus } from '../domain/leave.types';

/** What the API answers about leave (3.4). Amounts are in days (0.25 steps). */

export interface LeavePersonRef {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  companyId: string | null;
  companyName: string | null;
  managerId: string | null;
  managerName: string | null;
}

export interface LeaveRequestView {
  id: string;
  userId: string;
  userName: string;
  department: string | null;
  companyId: string | null;
  companyName: string | null;
  category: LeaveCategory;
  /** "CL/SL" */
  categoryLabel: string;
  kind: LeaveKind;
  part: LeavePart | null;
  /** "Full day", "Half day (first half)" */
  kindLabel: string;
  startDate: string;
  endDate: string;
  /** "Mon 9 to Fri 13 Nov" */
  span: string;
  year: number;
  /** Days charged (working days only). */
  days: number;
  /** "2.5 days" */
  daysLabel: string;
  dates: { date: string; label: string; days: number }[];
  /** Part days: when on the shift, "09:30 to 14:00". */
  partTimes: string | null;
  reason: string;
  status: LeaveStatus;
  statusLabel: string;
  approverRole: DeciderRole | null;
  /** Pending: who decides it ("Bala Krishnan", "the Super Admins"). */
  waitingFor: string | null;
  decidedById: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the caller may do with it now. */
  can: { cancel: boolean; decide: boolean; revoke: boolean };
}

export interface CategoryBalanceView {
  category: LeaveCategory;
  label: string;
  name: string;
  year: number;
  grantedDays: number;
  /** DEFAULT: the policy's days; PERSON: their own quota. */
  grantSource: 'DEFAULT' | 'PERSON';
  prorated: boolean;
  /** EL/PL brought in from last year (a debt is negative). */
  carriedDays: number;
  /** Last year's balance that did not come over (CL/SL lapses; EL/PL over the cap). */
  lapsedDays: number;
  adjustedDays: number;
  takenDays: number;
  pendingDays: number;
  /** granted + carried + adjusted − taken */
  balanceDays: number;
  /** balance − pending */
  availableDays: number;
  /** What a new request may use (next year's carry-over is spendable from 1 January). */
  spendableDays: number;
  yearEnd: 'LAPSES' | 'CARRIES';
  /** EL/PL: the most that carries into next year; null = all of it. */
  carryCapDays: number | null;
}

export interface LedgerLine {
  /** YYYY-MM-DD the line belongs to. */
  date: string;
  kind: 'GRANT' | 'CARRY' | 'ADJUSTMENT' | 'QUOTA' | 'LEAVE' | 'PENDING';
  category: LeaveCategory;
  /** Signed effect on the balance (pending: what is reserved, negative). */
  days: number;
  text: string;
  byName: string | null;
  requestId: string | null;
  at: string | null;
}

export interface LeavePolicyView {
  enabled: boolean;
  clslDaysPerYear: number;
  elplDaysPerYear: number;
  elplCarryCapDays: number | null;
  elplNoticeDays: number;
  clslBackdateDays: number;
  approver: ApproverRoute;
  approverLabel: string;
  prorateJoiners: boolean;
  startedOn: string;
  year: number;
  routes: { value: ApproverRoute; label: string }[];
  categories: {
    category: LeaveCategory;
    label: string;
    name: string;
    daysPerYear: number;
    yearEnd: 'LAPSES' | 'CARRIES';
    rule: string;
  }[];
  kinds: {
    kind: LeaveKind;
    label: string;
    days: number;
    parts: { part: LeavePart; label: string }[];
  }[];
  bounds: Record<string, { min: number; max: number }>;
  /** The caller may change the policy (Super Admin, Super Manager) and who approves (Super Admin). */
  canEdit: boolean;
  canRoute: boolean;
}

export interface MyLeaveView {
  today: string;
  timezone: string;
  year: number;
  policy: LeavePolicyView;
  balances: CategoryBalanceView[];
  /** Next year's balances once there is anything in it, or from December. */
  nextYear: { year: number; balances: CategoryBalanceView[] } | null;
  /** Who decides my requests now. */
  waitingFor: string | null;
  upcoming: LeaveRequestView[];
  requests: LeaveRequestView[];
  ledger: LedgerLine[];
}

export interface LeavePreview {
  ok: boolean;
  /** The first thing that stops the request, if any. */
  problem: { field: string; code: string; message: string } | null;
  category: LeaveCategory | null;
  kind: LeaveKind | null;
  part: LeavePart | null;
  startDate: string | null;
  endDate: string | null;
  year: number | null;
  dates: { date: string; label: string; charged: boolean; days: number; why: string | null }[];
  days: number;
  daysLabel: string;
  partTimes: string | null;
  balance: { category: LeaveCategory; label: string; beforeDays: number; afterDays: number } | null;
  waitingFor: string | null;
  /** True when nobody needs to approve it (a lone Super Admin). */
  approvedAtOnce: boolean;
}

export interface PersonBalanceRow {
  user: LeavePersonRef;
  year: number;
  clsl: CategoryBalanceView;
  elpl: CategoryBalanceView;
  quota: { clslDaysPerYear: number | null; elplDaysPerYear: number | null };
  upcomingDays: number;
}

export interface PersonLeaveView extends PersonBalanceRow {
  balances: CategoryBalanceView[];
  ledger: LedgerLine[];
  requests: LeaveRequestView[];
  /** The caller may change quotas and balances. */
  canAdjust: boolean;
}

export interface LeaveAdjustmentView {
  id: string;
  userId: string;
  userName: string;
  companyName: string | null;
  year: number;
  category: LeaveCategory;
  categoryLabel: string;
  mode: 'ADD' | 'SUBTRACT' | 'SET' | 'QUOTA';
  days: number;
  /** "+2 days", "−0.5 day", "Set to 8 days", "Yearly 15 days" */
  label: string;
  reason: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
}
