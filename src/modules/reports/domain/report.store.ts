import { MonthSnapshot } from './report.types';

export const REPORT_STORE = Symbol('REPORT_STORE');

export interface ReportRunRow {
  id: string;
  month: string;
  scope: 'TEAM' | 'ALL';
  ownerId: string;
  generatedAt: Date;
  summary: Record<string, unknown>;
}

export interface MonthLockRow {
  month: string;
  lockedById: string;
  lockedAt: Date;
}

export type LockMonthResult =
  | { ok: true; lock: MonthLockRow; created: boolean }
  /** Work sessions dated in the month still open, items or leave (3.4) dated in it still PENDING. */
  | {
      ok: false;
      reason: 'OPEN_SESSIONS' | 'PENDING_APPROVALS' | 'PENDING_LEAVE' | 'PENDING_WFH';
      count: number;
    };

/** report_runs and month_locks, per organisation (4.0). */
export interface ReportStore {
  upsertRun(
    companyId: string,
    month: string,
    scope: 'TEAM' | 'ALL',
    ownerId: string,
    summary: Record<string, unknown>,
  ): Promise<void>;
  /** The organisation's runs: one owner's, or (null) every ALL-scope run. */
  listRuns(companyId: string, ownerId: string | null): Promise<ReportRunRow[]>;
  /** `SCOPE|ownerId` of every run stored for the organisation's month. */
  runKeys(companyId: string, month: string): Promise<Set<string>>;
  /**
   * When 3.1 first booted on this database (app_settings key `system`,
   * `firstBootAt`): stored once, at `now` if it was never stored, then read back.
   */
  recordFirstBoot(now: Date): Promise<Date>;
  findLock(companyId: string, month: string): Promise<MonthLockRow | null>;
  findSnapshot(companyId: string, month: string): Promise<MonthSnapshot | null>;
  /**
   * Locks a month in one transaction holding the month's exclusive advisory lock
   * (decisions and new pending items take the shared one): refused while a work
   * session dated in it is open or anything dated in it is PENDING; the snapshot
   * is built inside, so nothing can slip in between. Already locked: returned as
   * is (created false).
   */
  lockMonth(
    companyId: string,
    month: string,
    lockedById: string,
    buildSnapshot: () => Promise<MonthSnapshot>,
  ): Promise<LockMonthResult>;
  /** True when a lock was removed. */
  unlockMonth(companyId: string, month: string): Promise<boolean>;
  /**
   * 3.2: the organisation's work sessions dated in the month that are still open
   * (at most `limit`), oldest first.
   */
  openSessionsInMonth(
    companyId: string,
    month: string,
    limit: number,
  ): Promise<OpenSessionBlocker[]>;
  /** 3.4: the organisation's leave requests with a day in the month still waiting. */
  pendingLeaveInMonth(
    companyId: string,
    month: string,
    limit: number,
    userIds?: string[],
  ): Promise<{ count: number; items: PendingLeaveBlocker[] }>;
  /** The organisation's work-from-home requests with a day in the month still waiting (3.5). */
  pendingWfhInMonth(
    companyId: string,
    month: string,
    limit: number,
    userIds?: string[],
  ): Promise<{ count: number; items: PendingWfhBlocker[] }>;
}

/** A work-from-home request with a day in the month that waits for a decision (3.5). */
export interface PendingWfhBlocker {
  id: string;
  userId: string;
  userName: string;
  startDate: string;
  endDate: string;
  days: number;
}

/** A leave request with a day in the month that waits for a decision (3.4). */
export interface PendingLeaveBlocker {
  id: string;
  userId: string;
  userName: string;
  category: 'CLSL' | 'ELPL' | 'COMPOFF';
  startDate: string;
  endDate: string;
  days: number;
}

/** A working day dated in the month that has not ended yet. */
export interface OpenSessionBlocker {
  userId: string;
  userName: string;
  date: string;
  startedAt: string;
}
