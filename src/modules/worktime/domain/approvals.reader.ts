import { ApproverRole } from '@modules/shifts/domain/shift.types';
import { ApprovalCategory } from './approval-copy';

export const APPROVALS_READER = Symbol('APPROVALS_READER');

export type ApprovalType = 'BREAK' | 'MEETING' | 'AWAY';

export interface ApprovalRef {
  type: ApprovalType;
  id: string;
}

/** Whose items a list covers (4.0: by organisation and department, docs/4.0/SPEC.md 1.3). */
export type ApprovalScope =
  /** No scope of its own: only for queries already limited to `userIds` the caller may see. */
  | { kind: 'ALL' }
  /** Everything in an organisation except the caller's own (an Admin's "all"). */
  | { kind: 'ORG'; companyId: string; excludeUserId: string }
  /** An Admin's "mine": waiting for the Admin, or escalated, in the organisation. */
  | { kind: 'ORG_ADMIN_MINE'; companyId: string; excludeUserId: string }
  /** A Manager's: Staff in these departments of the organisation. */
  | { kind: 'DEPTS'; companyId: string; departmentIds: string[]; excludeUserId: string }
  /** The person's own items (GET /approvals/me, agent History). */
  | { kind: 'SUBJECT'; userId: string };

export type DecidedStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ApprovalQuery {
  scope: ApprovalScope;
  statuses: DecidedStatus[];
  type?: ApprovalType;
  category?: ApprovalCategory;
  /** Only PENDING items past their due time at this instant. */
  overdueAt?: Date;
  /** Only items due in [from, to] (inclusive). */
  dueWithin?: { from: Date; to: Date };
  /** Only items that were escalated (past due). */
  escalatedOnly?: boolean;
  date?: string;
  fromDate?: string;
  toDate?: string;
  userId?: string;
  userIds?: string[];
  skip?: number;
  take?: number;
}

export interface SlaClaim {
  type: ApprovalType;
  id: string;
  userId: string;
  approverId: string | null;
  approverRole: ApproverRole | null;
  /** The subject's organisation and department (who gets reminded and escalated to). */
  companyId: string | null;
  departmentId: string | null;
}

export interface DigestRow {
  approverId: string | null;
  approverRole: ApproverRole | null;
  companyId: string | null;
  departmentId: string | null;
  pending: number;
  dueSoon: number;
  overdue: number;
}

/**
 * Break and meeting records read as one list of approval items (SQL UNION), so
 * paging and sorting work across both: PENDING by due time ascending (overdue
 * first), decided ones by decision (else creation) time, newest first.
 */
export interface ApprovalsReader {
  list(q: ApprovalQuery): Promise<{ total: number; refs: ApprovalRef[] }>;
  count(q: ApprovalQuery): Promise<number>;
  /** Items decided in [from, to) with this status, within the scope. */
  countDecidedBetween(
    scope: ApprovalScope,
    status: 'APPROVED' | 'REJECTED',
    from: Date,
    to: Date,
  ): Promise<number>;
  /** Overdue pending items, and the earliest due time of any pending item (overdue or not). */
  overdueIn(scope: ApprovalScope, now: Date): Promise<{ count: number; oldestDueAt: Date | null }>;
  /** Pending items due within 12h that were never reminded (nothing is marked). */
  remindersDue(now: Date): Promise<SlaClaim[]>;
  /** Pending items past due that were never escalated (nothing is marked). */
  escalationsDue(now: Date): Promise<SlaClaim[]>;
  /** Sets reminded_at on these items (once), after their reminder went out. */
  markReminded(refs: ApprovalRef[], now: Date): Promise<number>;
  /** Sets escalated_at on these items (once), after their escalation went out. */
  markEscalated(refs: ApprovalRef[], now: Date): Promise<number>;
  /**
   * Gives every PENDING item without a due time one (created + SLA): a row an old
   * process wrote during the deploy window. Returns how many.
   */
  fillMissingDueAt(slaHours: number): Promise<number>;
  /** Pending, due within 24h and overdue counts per organisation, department and approver role. */
  digestCounts(now: Date): Promise<DigestRow[]>;
  /** Which of these months (YYYY-MM) are locked, as `companyId|month`. */
  lockedMonths(companyIds: string[], months: string[]): Promise<Set<string>>;
  /** PENDING items per (person, day) in a date range, and how many are past due. */
  pendingByUserDate(
    userIds: string[],
    fromDate: string,
    toDate: string,
    now: Date,
  ): Promise<{ userId: string; date: string; pending: number; overdue: number }[]>;
  /** How many items of the organisation dated in the month are PENDING (optionally only these people's). */
  pendingInMonth(companyId: string, month: string, userIds?: string[]): Promise<number>;
}
