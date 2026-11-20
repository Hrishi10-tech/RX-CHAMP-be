import { ExportKind, ExportStatus } from './screenshot-export';

export const SCREENSHOT_EXPORT_REPOSITORY = Symbol('SCREENSHOT_EXPORT_REPOSITORY');

export interface ExportRecord {
  id: string;
  kind: ExportKind;
  status: ExportStatus;
  requestedById: string;
  /** 4.0: the organisation it belongs to; archives and deletions cover only its people. */
  companyId: string | null;
  userId: string | null;
  month: string | null;
  fromDate: string | null;
  toDate: string | null;
  fromTime: string | null;
  toTime: string | null;
  archiveId: string | null;
  total: number;
  done: number;
  missing: number;
  bytes: number;
  storageKey: string | null;
  fileName: string | null;
  error: string | null;
  complete: boolean;
  coveredUntil: Date | null;
  cancelRequested: boolean;
  lastSeenAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  downloadedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface NewExport {
  kind: ExportKind;
  requestedById: string;
  companyId?: string | null;
  userId?: string | null;
  month?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  fromTime?: string | null;
  toTime?: string | null;
  archiveId?: string | null;
  total: number;
}

/** One screenshot as the exports need it. */
export interface ShotRow {
  id: string;
  userId: string;
  storageKey: string;
  kind: 'AUTO' | 'MANUAL';
  takenAt: Date;
  createdAt: Date;
}

export interface ShotOwner {
  id: string;
  name: string;
  email: string;
  department: string | null;
}

export interface MonthShotCount {
  month: string;
  count: number;
}

export interface ScreenshotExportRepository {
  create(data: NewExport): Promise<ExportRecord>;
  find(id: string): Promise<ExportRecord | null>;
  /** The oldest QUEUED job, claimed as RUNNING (null when none, or another took it). */
  claimNext(now: Date): Promise<ExportRecord | null>;
  /** A job left RUNNING by a stopped server: FAILED. Returns how many. */
  failInterrupted(message: string, now: Date): Promise<number>;
  update(id: string, data: Partial<Omit<ExportRecord, 'id' | 'kind' | 'createdAt'>>): Promise<void>;
  /** The portal is still watching (progress poll). */
  touch(id: string, now: Date): Promise<void>;
  requestCancel(id: string): Promise<void>;
  /** 4.0: the organisation's jobs of the month. */
  listForMonth(kind: ExportKind, month: string, companyId: string): Promise<ExportRecord[]>;
  /** A job of these kinds still QUEUED or RUNNING (one at a time per month or person). */
  findActive(filter: {
    kind?: ExportKind;
    month?: string;
    userId?: string;
    requestedById?: string;
    companyId?: string;
  }): Promise<ExportRecord | null>;
  /** Finished jobs whose file is past its keep date. */
  listExpired(now: Date): Promise<ExportRecord[]>;
  /** Recent jobs a person started (the portal lists them). */
  listRecent(
    requestedById: string | null,
    limit: number,
    companyId?: string,
  ): Promise<ExportRecord[]>;

  // ---- The screenshots themselves ----
  countShots(filter: {
    userId?: string;
    companyId?: string;
    from: Date;
    to: Date;
    createdBefore?: Date;
  }): Promise<number>;
  /** Screenshots in [from, to), oldest first, a page at a time (after `afterId` at the same instant). */
  listShots(
    filter: { userId?: string; companyId?: string; from: Date; to: Date; createdBefore?: Date },
    page: { after: { takenAt: Date; id: string } | null; take: number },
  ): Promise<ShotRow[]>;
  /** Per business day: how many, the first and the last (the cover page). */
  summarizeDays(
    filter: { userId: string; from: Date; to: Date; createdBefore?: Date },
    tz: string,
  ): Promise<{ date: string; count: number; first: Date; last: Date }[]>;
  /** The people the screenshots belong to (any status, for names in the files). */
  owners(userIds: string[]): Promise<ShotOwner[]>;
  /** Distinct owners of screenshots in [from, to). */
  ownersIn(from: Date, to: Date, companyId?: string): Promise<string[]>;
  /** Screenshots per month (business timezone), newest month first. */
  countByMonth(tz: string, since: Date, companyId?: string): Promise<MonthShotCount[]>;
  deleteShots(ids: string[]): Promise<number>;
}
