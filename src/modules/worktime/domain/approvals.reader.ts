import { ApproverRole } from '@modules/shifts/domain/shift.types';
import { ApprovalCategory } from './approval-copy';

export const APPROVALS_READER = Symbol('APPROVALS_READER');

export type ApprovalType = 'BREAK' | 'MEETING';

export interface ApprovalRef {
  type: ApprovalType;
  id: string;
}

/** Whose items a list covers. */
export type ApprovalScope =
  /** Every item (a Super Admin's scope=all). */
  | { kind: 'ALL' }
  /** Routed to this approver (a Manager's mine). */
  | { kind: 'APPROVER'; approverId: string }
  /** A Super Admin's mine: routed to them, the Super Admin pool, and every escalated item. */
  | { kind: 'SUPER_ADMIN_MINE'; approverId: string }
  /** The person's own items (GET /approvals/me). */
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
  /** Only items that were escalated to the Super Admins. */
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
}

export interface DigestRow {
  approverId: string | null;
  approverRole: ApproverRole | null;
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
  /** PENDING items routed to this approver (approverId) past their due time. */
  overdueRoutedTo(
    approverId: string,
    now: Date,
  ): Promise<{ count: number; oldestDueAt: Date | null }>;
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
  /** Pending, due within 24h and overdue counts per approver (id or pool), for the digest. */
  digestCounts(now: Date): Promise<DigestRow[]>;
  /** Which of these months (YYYY-MM) are locked. */
  lockedMonths(months: string[]): Promise<Set<string>>;
  /** PENDING items per (person, day) in a date range, and how many are past due. */
  pendingByUserDate(
    userIds: string[],
    fromDate: string,
    toDate: string,
    now: Date,
  ): Promise<{ userId: string; date: string; pending: number; overdue: number }[]>;
  /** How many items dated in the month are PENDING (optionally only these people's). */
  pendingInMonth(month: string, userIds?: string[]): Promise<number>;
}
