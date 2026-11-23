import { DeciderRole } from './routing';
import { LeaveCategory, LeaveKind, LeavePart, LeaveStatus } from './leave.types';

export const LEAVE_REPOSITORY = Symbol('LEAVE_REPOSITORY');

export type GrantSource = 'DEFAULT' | 'PERSON';
export type AdjustmentMode = 'ADD' | 'SUBTRACT' | 'SET' | 'QUOTA';

export interface LeaveAccountRecord {
  id: string;
  userId: string;
  year: number;
  category: LeaveCategory;
  grantedUnits: number;
  grantSource: GrantSource;
  prorated: boolean;
  carryCapUnits: number | null;
  createdAt: Date;
}

export interface NewLeaveAccount {
  userId: string;
  year: number;
  category: LeaveCategory;
  grantedUnits: number;
  grantSource: GrantSource;
  prorated: boolean;
  carryCapUnits: number | null;
}

export interface AccountUpdate {
  id: string;
  grantedUnits?: number;
  grantSource?: GrantSource;
  prorated?: boolean;
  carryCapUnits?: number | null;
}

export interface LeaveDayRecord {
  date: string;
  mask: number;
  units: number;
}

export interface LeaveRequestRecord {
  id: string;
  userId: string;
  category: LeaveCategory;
  kind: LeaveKind;
  part: LeavePart | null;
  startDate: string;
  endDate: string;
  year: number;
  units: number;
  reason: string;
  status: LeaveStatus;
  approverRole: DeciderRole | null;
  approverId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Charged days, in date order. */
  days: LeaveDayRecord[];
}

export interface NewLeaveRequest {
  userId: string;
  category: LeaveCategory;
  kind: LeaveKind;
  part: LeavePart | null;
  startDate: string;
  endDate: string;
  year: number;
  units: number;
  reason: string;
  status: LeaveStatus;
  approverRole: DeciderRole | null;
  approverId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
}

export interface RequestPatch {
  status?: LeaveStatus;
  decidedById?: string | null;
  decidedAt?: Date | null;
  decisionNote?: string | null;
  cancelledAt?: Date | null;
  units?: number;
}

export interface LeaveAdjustmentRecord {
  id: string;
  userId: string;
  year: number;
  category: LeaveCategory;
  deltaUnits: number;
  mode: AdjustmentMode;
  targetUnits: number | null;
  reason: string;
  createdById: string;
  createdAt: Date;
}

export type NewLeaveAdjustment = Omit<LeaveAdjustmentRecord, 'id' | 'createdAt'>;

export interface LeaveQuotaRecord {
  userId: string;
  category: LeaveCategory;
  unitsPerYear: number;
}

/** Per year and pool: what the requests and adjustments add up to. */
export interface LeaveSums {
  year: number;
  category: LeaveCategory;
  adjustedUnits: number;
  takenUnits: number;
  pendingUnits: number;
}

/** A charged day of an active request, for other modules (attendance, Team today, reports). */
export interface HeldLeaveDay {
  requestId: string;
  userId: string;
  date: string;
  mask: number;
  units: number;
  category: LeaveCategory;
  status: LeaveStatus;
}

export interface RequestFilter {
  userId?: string;
  userIds?: string[];
  statuses?: LeaveStatus[];
  /** Requests overlapping [from, to]. */
  from?: string;
  to?: string;
  category?: LeaveCategory;
  year?: number;
  limit?: number;
  /** NEWEST (created, newest first, the default) or SOONEST (first day, soonest first). */
  order?: 'NEWEST' | 'SOONEST';
}

/** What a transaction holding one person's leave lock may do. */
export interface LeaveTx {
  /** Shared month lock, then 409 MONTH_LOCKED when the month is locked for payroll. */
  /** 4.0: months lock per organisation, so the person's organisation decides. */
  assertMonthOpen(dateKey: string, userId: string): Promise<void>;
  /** Shared month lock, then whether the month is locked. */
  isMonthLocked(dateKey: string, userId: string): Promise<boolean>;
  accounts(userId: string): Promise<LeaveAccountRecord[]>;
  createAccounts(rows: NewLeaveAccount[]): Promise<void>;
  updateAccount(
    id: string,
    patch: Partial<
      Pick<LeaveAccountRecord, 'grantedUnits' | 'grantSource' | 'prorated' | 'carryCapUnits'>
    >,
  ): Promise<void>;
  sums(userId: string): Promise<LeaveSums[]>;
  /** The person's pending and approved days in [from, to], but those of `exceptRequestId`. */
  heldDays(
    userId: string,
    from: string,
    to: string,
    exceptRequestId?: string,
  ): Promise<HeldLeaveDay[]>;
  findRequest(id: string): Promise<LeaveRequestRecord | null>;
  insertRequest(data: NewLeaveRequest, days: LeaveDayRecord[]): Promise<LeaveRequestRecord>;
  updateRequest(
    id: string,
    patch: RequestPatch,
    days?: LeaveDayRecord[],
  ): Promise<LeaveRequestRecord>;
  insertAdjustment(data: NewLeaveAdjustment): Promise<LeaveAdjustmentRecord>;
  quotas(userId: string): Promise<LeaveQuotaRecord[]>;
  setQuota(
    userId: string,
    category: LeaveCategory,
    units: number | null,
    byId: string,
  ): Promise<void>;
}

export interface LeaveRepository {
  /** Runs `fn` in one transaction holding the person's leave lock (requests, decisions, adjustments). */
  inUserLock<T>(userId: string, fn: (tx: LeaveTx) => Promise<T>): Promise<T>;
  findRequest(id: string): Promise<LeaveRequestRecord | null>;
  listRequests(filter: RequestFilter): Promise<LeaveRequestRecord[]>;
  /** Accounts of these people (one year, or every year). */
  accountsOf(userIds: string[], year?: number): Promise<LeaveAccountRecord[]>;
  createAccounts(rows: NewLeaveAccount[]): Promise<void>;
  sumsOf(userIds: string[]): Promise<Map<string, LeaveSums[]>>;
  adjustmentsOf(filter: {
    userId?: string;
    userIds?: string[];
    year?: number;
    limit?: number;
  }): Promise<LeaveAdjustmentRecord[]>;
  quotasOf(userIds: string[]): Promise<LeaveQuotaRecord[]>;
  /** Every account from `fromYear` on (a policy change updates those on the default). */
  accountsFromYear(fromYear: number): Promise<LeaveAccountRecord[]>;
  updateAccounts(rows: AccountUpdate[]): Promise<void>;
  /** Active requests' charged days for these people in [from, to]. */
  heldDaysOf(userIds: string[], from: string, to: string): Promise<HeldLeaveDay[]>;
  /** Every active request with a charged day on or after `fromDate` (repricing). */
  activeRequestsFrom(fromDate: string): Promise<LeaveRequestRecord[]>;
  /** When each person's account was created (their first day). */
  joinedAt(userIds: string[]): Promise<Map<string, Date>>;
  /** Pending requests with a charged day in this month (a month lock waits for them). */
  pendingInMonth(month: string): Promise<number>;
  /** Active people holding a role (routing and "waiting for" labels). */
  activeRoleIds(role: 'SUPER_MANAGER' | 'SUPER_ADMIN'): Promise<string[]>;
}
