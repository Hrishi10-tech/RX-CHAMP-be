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
  /** Work sessions dated in the month still open, or items dated in it still PENDING. */
  | { ok: false; reason: 'OPEN_SESSIONS' | 'PENDING_APPROVALS'; count: number };

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
}
