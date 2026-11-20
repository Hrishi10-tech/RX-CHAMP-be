import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, Interval } from '@nestjs/schedule';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { isAdminLike, orgOf, PersonFactsReader, requireOrg } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import {
  archiveDue,
  archiveFileName,
  archiveFolders,
  ASSUMED_BYTES_PER_SHOT,
  ASSUMED_SEC_PER_SHOT,
  dayFileName,
  dayLabel,
  ExportKind,
  ExportStatus,
  lastDayOfMonth,
  monthName,
  monthStart,
  nextMonth,
  progressOf,
  PURGE_BLOCK_TEXT,
  purgeBlock,
  PurgeBlock,
  qualifyingArchive,
  reportFileName,
  reportPeriod,
  ReportPeriodInput,
  UNWATCHED_CANCEL_MS,
  weekdayShort,
} from '../domain/screenshot-export';
import {
  ExportRecord,
  SCREENSHOT_EXPORT_REPOSITORY,
  ScreenshotExportRepository,
  ShotOwner,
  ShotRow,
} from '../domain/screenshot-export.repository';
import { assertCanAccess } from './screenshot-access';
import { S3StorageService, StreamUpload } from '../infrastructure/s3-storage.service';
import {
  ARCHIVE_QUALITY,
  ImageQuality,
  pdfText,
  prepareImage,
  PreparedImage,
  REPORT_QUALITY,
  ScreenshotPdf,
} from './screenshot-pdf';

export interface ExportJobView {
  id: string;
  kind: ExportKind;
  status: ExportStatus;
  /** What it is, in words ("Asha Rao, 14 Oct 2026, 17:00 to 19:00"). */
  title: string;
  userId: string | null;
  month: string | null;
  total: number;
  done: number;
  missing: number;
  progress: { fraction: number; etaSec: number | null; elapsedSec: number };
  /** Where it stands, in words. */
  stage: string;
  bytes: number;
  fileName: string | null;
  downloadable: boolean;
  complete: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  downloadedAt: string | null;
  expiresAt: string | null;
}

export interface MonthArchiveView {
  month: string;
  label: string;
  ended: boolean;
  /** Screenshots of the month still stored. */
  screenshots: number;
  /** Archive and delete by this day (the end of the month after it). */
  dueBy: string;
  overdue: boolean;
  latestArchive: ExportJobView | null;
  /** The archive that allows deleting the month (complete, made after it ended). */
  qualifyingArchive: ExportJobView | null;
  /** Screenshots that archive holds (deletable now). */
  deletable: number;
  /** Screenshots uploaded after that archive started (kept until the next one). */
  newerThanArchive: number;
  canDelete: boolean;
  deleteBlockedBy: PurgeBlock | null;
  deleteBlockedText: string | null;
  lastPurge: ExportJobView | null;
  running: ExportJobView | null;
}

export interface ArchiveNudgeView {
  month: string;
  label: string;
  screenshots: number;
  dueBy: string;
  overdue: boolean;
  /** What is left to do: archive, download, or delete. */
  step: 'ARCHIVE' | 'DOWNLOAD' | 'DELETE';
  message: string;
}

/** How many screenshots are read from storage at once. */
const FETCH_AHEAD = 4;
/** Stop feeding the PDF while this much is waiting to be uploaded. */
const BUFFER_LIMIT_BYTES = 48 * 1024 * 1024;
/** How often the worker re-reads its job (cancel, progress window closed). */
const CHECK_EVERY_MS = 2_000;
const PAGE = 200;

class Cancelled extends Error {
  constructor(readonly why: string) {
    super(why);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Screenshot reports, monthly archives and monthly deletion (3.2, fixes 6 and 7).
 *
 * Each runs as a background job, one at a time on this server, while the portal
 * shows a progress window that polls it. Closing the window (or the tab) cancels
 * the job; it then has to be started again. Files are kept in storage for
 * SCREENSHOT_EXPORT_RETENTION_DAYS (7) and then removed.
 */
@Injectable()
export class ScreenshotExportService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScreenshotExportService.name);
  private busy = false;
  private stopping = false;

  constructor(
    @Inject(SCREENSHOT_EXPORT_REPOSITORY) private readonly jobs: ScreenshotExportRepository,
    // 4.0: who may see whose screenshots (organisation, departments, grants).
    private readonly facts: PersonFactsReader,
    private readonly s3: S3StorageService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      const n = await this.jobs.failInterrupted(
        'The server restarted while this was running. Start it again.',
        new Date(),
      );
      if (n) this.logger.warn(`${n} screenshot export(s) interrupted by a restart`);
    } catch (err) {
      this.logger.warn(`could not check interrupted exports: ${(err as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
  }

  private get tz(): string {
    return appTimezone();
  }

  private retentionMs(): number {
    return (this.config.get<number>('exports.retentionDays') ?? 7) * 86_400_000;
  }

  // ---- Who may do what ----------------------------------------------------------------

  /**
   * 4.0: monthly archives and deletion are per organisation, for its Admin (or a
   * Super Admin with that organisation in view). Answers the organisation.
   */
  private assertOrgAdmin(me: AuthenticatedUser): string {
    if (!isAdminLike(me)) {
      throw new ForbiddenError('Only the organisation admin can archive or delete screenshots.');
    }
    return requireOrg(me);
  }

  /**
   * 4.0: a report on someone's screenshots needs what viewing them needs (the
   * organisation's admins; a Manager with the screenshots grant for Staff in their
   * departments). Never on one's own: Staff use the agent, not the portal.
   */
  private async assertCanReport(me: AuthenticatedUser, userId: string): Promise<void> {
    if (!isAdminLike(me) && me.role !== Role.MANAGER && me.role !== Role.SUPER_MANAGER) {
      throw new ForbiddenError(
        'Only a Manager or the organisation admin can download screenshot reports.',
      );
    }
    if (userId === me.id) throw new ForbiddenError('You cannot report on your own screenshots.');
    await assertCanAccess(me, userId, this.facts);
  }

  /** The job's own requester, or an admin of the organisation it belongs to. */
  private assertOwnJob(me: AuthenticatedUser, job: ExportRecord): void {
    if (job.requestedById === me.id) return;
    if (isAdminLike(me) && job.companyId && job.companyId === orgOf(me)) return;
    throw new ForbiddenError('This export is not yours.');
  }

  // ---- Reports (fix 6) --------------------------------------------------------------------

  private period(input: ReportPeriodInput, now: Date) {
    const r = reportPeriod(input, this.tz, dateKeyInZone(now, this.tz));
    if (!r.ok) throw new ValidationError(r.message);
    return r.period;
  }

  /** How many screenshots a report would hold, and roughly how long and how big. */
  async estimateReport(
    me: AuthenticatedUser,
    dto: ReportPeriodInput & { userId: string },
    now: Date,
  ): Promise<{ total: number; estimatedSec: number; estimatedBytes: number; periodLabel: string }> {
    await this.assertCanReport(me, dto.userId);
    const p = this.period(dto, now);
    const total = await this.jobs.countShots({ userId: dto.userId, from: p.from, to: p.to });
    return {
      total,
      estimatedSec: Math.round(total * ASSUMED_SEC_PER_SHOT + 2),
      estimatedBytes: total * ASSUMED_BYTES_PER_SHOT,
      periodLabel: p.label,
    };
  }

  async startReport(
    me: AuthenticatedUser,
    dto: ReportPeriodInput & { userId: string },
    now: Date,
  ): Promise<ExportJobView> {
    await this.assertCanReport(me, dto.userId);
    const p = this.period(dto, now);
    const busy = await this.jobs.findActive({ kind: 'PERSON_REPORT', requestedById: me.id });
    if (busy) {
      throw new ConflictError(
        'One of your screenshot reports is still being made. Wait for it or cancel it first.',
        'EXPORT_RUNNING',
      ).withDetails({ exportId: busy.id });
    }
    const total = await this.jobs.countShots({ userId: dto.userId, from: p.from, to: p.to });
    const job = await this.jobs.create({
      kind: 'PERSON_REPORT',
      requestedById: me.id,
      companyId: orgOf(me),
      userId: dto.userId,
      fromDate: p.fromDate,
      toDate: p.toDate,
      fromTime: p.fromTime,
      toTime: p.toTime,
      total,
    });
    void this.tick();
    return this.toView(job, now);
  }

  // ---- Archives and deletion (fix 7) -------------------------------------------------------

  async startArchive(me: AuthenticatedUser, month: string, now: Date): Promise<ExportJobView> {
    const companyId = this.assertOrgAdmin(me);
    const current = dateKeyInZone(now, this.tz).slice(0, 7);
    if (month > current) throw new ValidationError('That month has not started yet.');
    const busy = await this.jobs.findActive({ month, companyId });
    if (busy) {
      throw new ConflictError(
        `Something for ${monthName(month)} is already running. Wait for it or cancel it first.`,
        'EXPORT_RUNNING',
      ).withDetails({ exportId: busy.id });
    }
    const total = await this.jobs.countShots({
      companyId,
      from: monthStart(month, this.tz),
      to: monthStart(nextMonth(month), this.tz),
    });
    const job = await this.jobs.create({
      kind: 'MONTH_ARCHIVE',
      requestedById: me.id,
      companyId,
      month,
      total,
    });
    void this.tick();
    return this.toView(job, now);
  }

  async startPurge(me: AuthenticatedUser, month: string, now: Date): Promise<ExportJobView> {
    const companyId = this.assertOrgAdmin(me);
    const busy = await this.jobs.findActive({ month, companyId });
    if (busy) {
      throw new ConflictError(
        `Something for ${monthName(month)} is already running. Wait for it or cancel it first.`,
        'EXPORT_RUNNING',
      ).withDetails({ exportId: busy.id });
    }
    const state = await this.monthState(companyId, month, now);
    if (!state.canDelete || !state.archive) {
      const block = state.block ?? 'NO_ARCHIVE';
      throw new ConflictError(PURGE_BLOCK_TEXT[block], 'DELETE_NOT_ALLOWED').withDetails({
        block,
        month,
      });
    }
    const job = await this.jobs.create({
      kind: 'MONTH_PURGE',
      requestedById: me.id,
      companyId,
      month,
      archiveId: state.archive.id,
      total: state.deletable,
    });
    void this.tick();
    return this.toView(job, now);
  }

  private async monthState(companyId: string, month: string, now: Date) {
    const tz = this.tz;
    const from = monthStart(month, tz);
    const to = monthStart(nextMonth(month), tz);
    const archives = await this.jobs.listForMonth('MONTH_ARCHIVE', month, companyId);
    const archive = qualifyingArchive(month, archives, tz);
    const [stored, deletable] = await Promise.all([
      this.jobs.countShots({ companyId, from, to }),
      archive?.coveredUntil
        ? this.jobs.countShots({ companyId, from, to, createdBefore: archive.coveredUntil })
        : Promise.resolve(0),
    ]);
    const current = dateKeyInZone(now, tz).slice(0, 7);
    const check = purgeBlock({ month, currentMonth: current, archives, deletable, tz });
    return {
      archives,
      archive: archive as ExportRecord | null,
      stored,
      deletable,
      canDelete: check.ok,
      block: check.ok ? null : check.block,
    };
  }

  /** Every month with screenshots in the last two years, newest first (Super Admin). */
  async months(me: AuthenticatedUser, now: Date): Promise<MonthArchiveView[]> {
    const companyId = this.assertOrgAdmin(me);
    const since = new Date(now.getTime() - 730 * 86_400_000);
    const counts = await this.jobs.countByMonth(this.tz, since, companyId);
    const current = dateKeyInZone(now, this.tz).slice(0, 7);
    const today = dateKeyInZone(now, this.tz);
    const months = new Set(counts.map((c) => c.month));
    // A month already deleted still shows, with its archive and deletion.
    for (const j of await this.jobs.listRecent(null, 100, companyId)) {
      if (j.month) months.add(j.month);
    }
    const out: MonthArchiveView[] = [];
    for (const month of [...months].sort().reverse()) {
      const state = await this.monthState(companyId, month, now);
      const purges = await this.jobs.listForMonth('MONTH_PURGE', month, companyId);
      const running =
        [...state.archives, ...purges].find(
          (j) => j.status === 'QUEUED' || j.status === 'RUNNING',
        ) ?? null;
      const due = archiveDue(month);
      const latest = state.archives[0] ?? null;
      out.push({
        month,
        label: monthName(month),
        ended: month < current,
        screenshots: state.stored,
        dueBy: due.dueBy,
        overdue: month < current && state.stored > 0 && today >= due.dueBy,
        latestArchive: latest ? this.toView(latest, now) : null,
        qualifyingArchive: state.archive ? this.toView(state.archive, now) : null,
        deletable: state.deletable,
        newerThanArchive: state.archive ? Math.max(0, state.stored - state.deletable) : 0,
        canDelete: state.canDelete,
        deleteBlockedBy: state.block,
        deleteBlockedText: state.block ? PURGE_BLOCK_TEXT[state.block] : null,
        lastPurge: purges[0] ? this.toView(purges[0], now) : null,
        running: running ? this.toView(running, now) : null,
      });
    }
    return out;
  }

  /**
   * The month a Super Admin should archive and delete next (the toast in the
   * portal): the oldest ended month that still holds screenshots.
   */
  async nudge(me: AuthenticatedUser, now: Date): Promise<ArchiveNudgeView | null> {
    // 4.0: the organisation's admin, inside an organisation.
    const companyId = isAdminLike(me) ? orgOf(me) : null;
    if (!companyId) return null;
    const since = new Date(now.getTime() - 730 * 86_400_000);
    const current = dateKeyInZone(now, this.tz).slice(0, 7);
    const today = dateKeyInZone(now, this.tz);
    const counts = (await this.jobs.countByMonth(this.tz, since, companyId))
      .filter((c) => c.month < current && c.count > 0)
      .sort((a, b) => a.month.localeCompare(b.month));
    const oldest = counts[0];
    if (!oldest) return null;
    const state = await this.monthState(companyId, oldest.month, now);
    const due = archiveDue(oldest.month);
    const label = monthName(oldest.month);
    const dueText = dayLabel(due.dueBy);
    // What is left to do. Screenshots that arrived after the archive started are not in
    // it, so once the rest is deleted they need an archive of their own.
    let step: ArchiveNudgeView['step'] = 'ARCHIVE';
    if (state.archive && !state.archive.downloadedAt) step = 'DOWNLOAD';
    else if (state.archive && state.deletable > 0) step = 'DELETE';
    const leftOver = step === 'ARCHIVE' && !!state.archive;
    const message =
      step === 'DOWNLOAD'
        ? `The ${label} archive is ready. Download it, then delete the month (due by ${dueText}).`
        : step === 'DELETE'
          ? `${label} is archived. Delete its screenshots to free storage (due by ${dueText}).`
          : leftOver
            ? `${label}: ${oldest.count} screenshot${oldest.count === 1 ? '' : 's'} arrived after its archive. ` +
              `Create a new archive, download it, then delete them (due by ${dueText}).`
            : `${label} screenshots are waiting: create the archive, download it, then delete the month (due by ${dueText}).`;
    return {
      month: oldest.month,
      label,
      screenshots: oldest.count,
      dueBy: due.dueBy,
      overdue: today >= due.dueBy,
      step,
      message,
    };
  }

  // ---- One job ------------------------------------------------------------------------------

  /** The job and its progress; reading it also tells the worker someone is watching. */
  async view(me: AuthenticatedUser, id: string, now: Date): Promise<ExportJobView> {
    const job = await this.jobs.find(id);
    if (!job) throw new NotFoundError('Unknown export');
    this.assertOwnJob(me, job);
    if (job.status === 'QUEUED' || job.status === 'RUNNING') await this.jobs.touch(id, now);
    return this.toView(job, now);
  }

  async cancel(me: AuthenticatedUser, id: string, now: Date): Promise<ExportJobView> {
    const job = await this.jobs.find(id);
    if (!job) throw new NotFoundError('Unknown export');
    this.assertOwnJob(me, job);
    await this.jobs.requestCancel(id);
    return this.toView((await this.jobs.find(id)) ?? job, now);
  }

  async download(
    me: AuthenticatedUser,
    id: string,
    now: Date,
  ): Promise<{ url: string; fileName: string; expiresAt: string | null }> {
    const job = await this.jobs.find(id);
    if (!job) throw new NotFoundError('Unknown export');
    this.assertOwnJob(me, job);
    if (job.status !== 'DONE' || !job.storageKey || !job.fileName) {
      throw new ConflictError('There is no file to download for this export.', 'EXPORT_NOT_READY');
    }
    const url = await this.s3.presignGet(job.storageKey, 3600, job.fileName);
    if (!job.downloadedAt) await this.jobs.update(id, { downloadedAt: now });
    return { url, fileName: job.fileName, expiresAt: job.expiresAt?.toISOString() ?? null };
  }

  async recent(me: AuthenticatedUser, now: Date): Promise<ExportJobView[]> {
    const rows = await this.jobs.listRecent(me.id, 20);
    return rows.map((j) => this.toView(j, now));
  }

  toView(job: ExportRecord, now: Date): ExportJobView {
    const progress = progressOf({ ...job, now });
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      title: this.titleOf(job),
      userId: job.userId,
      month: job.month,
      total: job.total,
      done: job.done,
      missing: job.missing,
      progress,
      stage: this.stageOf(job),
      bytes: job.bytes,
      fileName: job.fileName,
      downloadable: job.status === 'DONE' && !!job.storageKey,
      complete: job.complete,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      downloadedAt: job.downloadedAt?.toISOString() ?? null,
      expiresAt: job.expiresAt?.toISOString() ?? null,
    };
  }

  private titleOf(job: ExportRecord): string {
    if (job.kind === 'MONTH_ARCHIVE') return `Screenshot archive, ${monthName(job.month ?? '')}`;
    if (job.kind === 'MONTH_PURGE') return `Delete ${monthName(job.month ?? '')} screenshots`;
    const when =
      job.fromDate && job.toDate
        ? job.fromTime
          ? `${dayLabel(job.fromDate)}, ${job.fromTime} to ${job.toTime}`
          : job.fromDate === job.toDate
            ? dayLabel(job.fromDate)
            : `${dayLabel(job.fromDate)} to ${dayLabel(job.toDate)}`
        : '';
    return `Screenshot report, ${when}`;
  }

  private stageOf(job: ExportRecord): string {
    switch (job.status) {
      case 'QUEUED':
        return 'Waiting for another export to finish';
      case 'RUNNING':
        if (job.kind === 'MONTH_PURGE') return `Deleting ${job.done} of ${job.total}`;
        return job.done >= job.total && job.total > 0
          ? 'Finishing the file'
          : `Adding screenshot ${Math.min(job.done + 1, Math.max(job.total, 1))} of ${job.total}`;
      case 'DONE':
        return job.kind === 'MONTH_PURGE' ? `Deleted ${job.done} screenshots` : 'Ready to download';
      case 'CANCELLED':
        return 'Cancelled';
      default:
        return 'Failed';
    }
  }

  // ---- The worker ---------------------------------------------------------------------------

  /** Every few seconds: run the next job if nothing is running. */
  @Interval('screenshot-exports', 3_000)
  async tick(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      for (;;) {
        const job = await this.jobs.claimNext(new Date());
        if (!job) break;
        if (Date.now() - job.lastSeenAt.getTime() > UNWATCHED_CANCEL_MS) {
          await this.finish(job.id, 'CANCELLED', { error: 'The progress window was closed.' });
          continue;
        }
        await this.run(job);
      }
    } catch (err) {
      this.logger.warn(`screenshot exports: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Daily at 03:40: remove files past their keep date (the records stay). */
  @Cron('40 3 * * *', { name: 'screenshot-exports-cleanup', timeZone: appTimezone() })
  async cleanup(now: Date = new Date()): Promise<number> {
    let removed = 0;
    try {
      for (const job of await this.jobs.listExpired(now)) {
        try {
          if (job.storageKey) await this.s3.deleteObject(job.storageKey);
          await this.jobs.update(job.id, { storageKey: null });
          removed += 1;
        } catch (err) {
          this.logger.warn(`export ${job.id} file not removed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`export cleanup failed: ${(err as Error).message}`);
    }
    return removed;
  }

  private async run(job: ExportRecord): Promise<void> {
    try {
      if (job.kind === 'PERSON_REPORT') await this.runReport(job);
      else if (job.kind === 'MONTH_ARCHIVE') await this.runArchive(job);
      else await this.runPurge(job);
    } catch (err) {
      if (err instanceof Cancelled) {
        await this.finish(job.id, 'CANCELLED', { error: err.why });
      } else {
        this.logger.warn(`export ${job.id} failed: ${(err as Error).stack ?? err}`);
        await this.finish(job.id, 'FAILED', {
          error: 'Something went wrong while making the file. Start it again.',
        });
      }
    }
  }

  private async finish(
    id: string,
    status: ExportStatus,
    data: Partial<Omit<ExportRecord, 'id' | 'kind' | 'createdAt'>> = {},
  ): Promise<void> {
    await this.jobs.update(id, { ...data, status, finishedAt: new Date() });
  }

  /** Throws Cancelled when asked to stop, or when nobody watches any more. */
  private watcher(id: string) {
    let checkedAt = 0;
    let done = 0;
    let lastSaved = -1;
    return {
      progress: (n: number) => {
        done = n;
      },
      check: async (force = false) => {
        if (this.stopping) throw new Cancelled('The server is restarting. Start it again.');
        const now = Date.now();
        if (!force && now - checkedAt < CHECK_EVERY_MS) return;
        checkedAt = now;
        if (done !== lastSaved) {
          await this.jobs.update(id, { done });
          lastSaved = done;
        }
        const fresh = await this.jobs.find(id);
        if (!fresh || fresh.cancelRequested) throw new Cancelled('Cancelled.');
        if (now - fresh.lastSeenAt.getTime() > UNWATCHED_CANCEL_MS) {
          throw new Cancelled('The progress window was closed.');
        }
      },
    };
  }

  /** Screenshots in time order, read a page at a time. */
  private async *shots(filter: {
    userId?: string;
    companyId?: string;
    from: Date;
    to: Date;
    createdBefore?: Date;
  }): AsyncGenerator<ShotRow> {
    let after: { takenAt: Date; id: string } | null = null;
    for (;;) {
      const page = await this.jobs.listShots(filter, { after, take: PAGE });
      if (!page.length) return;
      for (const s of page) yield s;
      const last = page[page.length - 1];
      after = { takenAt: last.takenAt, id: last.id };
      if (page.length < PAGE) return;
    }
  }

  /** Screenshots with their prepared images, in order, a few read ahead. */
  private async *withImages(
    source: AsyncGenerator<ShotRow>,
    quality: ImageQuality,
  ): AsyncGenerator<{ shot: ShotRow; image: PreparedImage | null }> {
    const queue: Promise<{ shot: ShotRow; image: PreparedImage | null }>[] = [];
    const load = async (shot: ShotRow) => {
      try {
        return {
          shot,
          image: await prepareImage(await this.s3.getObject(shot.storageKey), quality),
        };
      } catch {
        return { shot, image: null };
      }
    };
    for await (const shot of source) {
      queue.push(load(shot));
      if (queue.length >= FETCH_AHEAD) yield await queue.shift()!;
    }
    while (queue.length) yield await queue.shift()!;
  }

  /** Holds back while the upload catches up; throws when the upload has failed. */
  private async waitForUpload(stream: PassThrough, failed: () => Error | null): Promise<void> {
    for (;;) {
      const err = failed();
      if (err) throw err;
      if (stream.readableLength <= BUFFER_LIMIT_BYTES) return;
      await sleep(25);
    }
  }

  private watchUpload(upload: StreamUpload): () => Error | null {
    let failed: Error | null = null;
    upload.done().catch((err: Error) => {
      failed = err;
    });
    return () => failed;
  }

  private async requesterName(id: string): Promise<string> {
    const [p] = await this.jobs.owners([id]);
    return p?.name || 'RX Vision';
  }

  private async runReport(job: ExportRecord): Promise<void> {
    const tz = this.tz;
    const [person] = await this.jobs.owners([job.userId as string]);
    if (!person) throw new Error('person not found');
    const wholeMonth =
      !job.fromTime &&
      !!job.fromDate &&
      job.fromDate.endsWith('-01') &&
      job.toDate === lastDayOfMonth(job.fromDate.slice(0, 7));
    const period = reportPeriod(
      {
        mode: job.fromTime
          ? 'TIME_WINDOW'
          : wholeMonth
            ? 'MONTH'
            : job.fromDate === job.toDate
              ? 'DAY'
              : 'RANGE',
        month: job.fromDate?.slice(0, 7),
        date: job.fromDate ?? undefined,
        fromDate: job.fromDate ?? undefined,
        toDate: job.toDate ?? undefined,
        fromTime: job.fromTime ?? undefined,
        toTime: job.toTime ?? undefined,
      },
      tz,
      '9999-12-31',
    );
    if (!period.ok) throw new Error(period.message);
    const p = period.period;
    const filter = { userId: person.id, from: p.from, to: p.to };
    const watch = this.watcher(job.id);
    const days = await this.jobs.summarizeDays(filter, tz);
    const total = days.reduce((s, d) => s + d.count, 0);
    const fileName = reportFileName(person.name, p);
    const key = this.s3.exportKey(job.id, fileName);
    await this.jobs.update(job.id, { total, fileName });

    const pdf = new ScreenshotPdf({
      title: 'Screenshot report',
      person,
      periodLabel: p.label,
      tz,
      generatedAt: new Date(),
      generatedBy: await this.requesterName(job.requestedById),
    });
    const out = pdf.stream as PassThrough;
    const upload: StreamUpload = this.s3.uploadStream(key, out, 'application/pdf');
    const uploadFailed = this.watchUpload(upload);
    let missing = 0;
    try {
      pdf.cover(
        days.map((d) => ({
          date: d.date,
          label: `${weekdayShort(d.date)} ${dayLabel(d.date)}`,
          count: d.count,
          first: d.first,
          last: d.last,
        })),
        total,
        0,
      );
      let n = 0;
      for await (const { shot, image } of this.withImages(this.shots(filter), REPORT_QUALITY)) {
        n += 1;
        if (!image) missing += 1;
        pdf.shot({ takenAt: shot.takenAt, kind: shot.kind, image }, n, Math.max(total, n));
        watch.progress(n);
        await watch.check();
        await this.waitForUpload(out, uploadFailed);
      }
      await watch.check(true);
      await Promise.all([pdf.end(), upload.done()]);
    } catch (err) {
      await upload.abort();
      throw err;
    }
    await this.finish(job.id, 'DONE', {
      done: total,
      missing,
      storageKey: key,
      bytes: pdf.size,
      complete: true,
      expiresAt: new Date(Date.now() + this.retentionMs()),
    });
    this.logger.log(`screenshot report ${job.id}: ${total} screenshot(s), ${pdf.size} bytes`);
  }

  private async runArchive(job: ExportRecord): Promise<void> {
    const tz = this.tz;
    const month = job.month as string;
    const coveredUntil = job.startedAt ?? new Date();
    const from = monthStart(month, tz);
    const to = monthStart(nextMonth(month), tz);
    const watch = this.watcher(job.id);
    // 4.0: the job's organisation only.
    const companyId = job.companyId ?? '00000000-0000-0000-0000-000000000000';
    const total = await this.jobs.countShots({ companyId, from, to, createdBefore: coveredUntil });
    const fileName = archiveFileName(month);
    const key = this.s3.exportKey(job.id, fileName);
    await this.jobs.update(job.id, { total, fileName, coveredUntil });

    const ownerIds = await this.jobs.ownersIn(from, to, companyId);
    const owners: ShotOwner[] = await this.jobs.owners(ownerIds);
    const known = new Set(owners.map((o) => o.id));
    for (const id of ownerIds) {
      if (!known.has(id)) owners.push({ id, name: 'Removed user', email: '', department: null });
    }
    const folders = archiveFolders(month, owners);
    const generatedBy = await this.requesterName(job.requestedById);

    const out = new PassThrough();
    const zip = archiver('zip', { zlib: { level: 0 }, forceZip64: false });
    zip.on('warning', (err) => this.logger.warn(`archive ${job.id}: ${err.message}`));
    let zipError: Error | null = null;
    zip.on('error', (err) => {
      zipError = err;
    });
    zip.pipe(out);
    const upload = this.s3.uploadStream(key, out, 'application/zip');
    const uploadFailed = this.watchUpload(upload);
    const index: string[] = ['department,employee,email,date,screenshots,unreadable,file'];
    let done = 0;
    let missing = 0;
    const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const appendEntry = async (data: Buffer | string, name: string) => {
      const added = new Promise<void>((resolve) => zip.once('entry', () => resolve()));
      zip.append(data, { name });
      await added;
      if (zipError) throw zipError;
      await this.waitForUpload(out, uploadFailed);
    };
    try {
      const root = `${month} ${monthName(month).split(' ')[0]}`;
      for (const owner of [...owners].sort((a, b) =>
        (folders.get(a.id) ?? '').localeCompare(folders.get(b.id) ?? ''),
      )) {
        const folder = folders.get(owner.id) as string;
        let day: string | null = null;
        let dayMissing = 0;
        let dayShots: { takenAt: Date; kind: 'AUTO' | 'MANUAL'; image: PreparedImage | null }[] =
          [];
        const flush = async () => {
          if (!day || !dayShots.length) return;
          const pdf = new ScreenshotPdf(
            {
              title: 'Screenshot archive',
              person: owner,
              periodLabel: `${weekdayShort(day)} ${dayLabel(day)}`,
              tz,
              generatedAt: new Date(),
              generatedBy,
            },
            true,
          );
          pdf.cover(
            [
              {
                date: day,
                label: `${weekdayShort(day)} ${dayLabel(day)}`,
                count: dayShots.length,
                first: dayShots[0].takenAt,
                last: dayShots[dayShots.length - 1].takenAt,
              },
            ],
            dayShots.length,
            dayMissing,
          );
          dayShots.forEach((s, i) => pdf.shot(s, i + 1, dayShots.length));
          const bytes = await pdf.toBuffer();
          await appendEntry(bytes, `${folder}/${dayFileName(day)}`);
          index.push(
            [
              csv(owner.department ?? 'No department'),
              csv(owner.name),
              csv(owner.email),
              day,
              String(dayShots.length),
              String(dayMissing),
              csv(`${folder}/${dayFileName(day)}`),
            ].join(','),
          );
          dayShots = [];
          dayMissing = 0;
        };
        const source = this.shots({
          userId: owner.id,
          companyId,
          from,
          to,
          createdBefore: coveredUntil,
        });
        for await (const { shot, image } of this.withImages(source, ARCHIVE_QUALITY)) {
          const d = dateKeyInZone(shot.takenAt, tz);
          if (d !== day) {
            await flush();
            day = d;
          }
          if (!image) {
            dayMissing += 1;
            missing += 1;
          }
          dayShots.push({ takenAt: shot.takenAt, kind: shot.kind, image });
          done += 1;
          watch.progress(done);
          await watch.check();
        }
        await flush();
      }
      await appendEntry(index.join('\n') + '\n', `${root}/index.csv`);
      await appendEntry(
        pdfText(
          [
            `RX Vision screenshot archive: ${monthName(month)}`,
            '',
            `Screenshots: ${done}${missing ? ` (${missing} could not be read)` : ''}`,
            `People: ${owners.length}`,
            `Made by ${generatedBy} on ${new Date().toISOString()}`,
            '',
            'Layout: <Month>/<Department>/<Employee>/<YYYY-MM-DD Day>.pdf, one PDF per day with screenshots.',
            'Every page shows the date and time the screenshot was taken.',
            'index.csv lists every file.',
          ].join('\r\n'),
        ),
        `${root}/README.txt`,
      );
      await watch.check(true);
      const finalized = zip.finalize();
      await Promise.all([finalized, upload.done()]);
      if (zipError) throw zipError;
    } catch (err) {
      zip.abort();
      await upload.abort();
      throw err;
    }
    await this.finish(job.id, 'DONE', {
      done,
      missing,
      storageKey: key,
      bytes: zip.pointer(),
      complete: done === total,
      expiresAt: new Date(Date.now() + this.retentionMs()),
    });
    this.logger.log(`screenshot archive ${month} (${job.id}): ${done} screenshot(s)`);
  }

  private async runPurge(job: ExportRecord): Promise<void> {
    const tz = this.tz;
    const month = job.month as string;
    const archive = job.archiveId ? await this.jobs.find(job.archiveId) : null;
    if (!archive?.coveredUntil || !archive.complete || archive.status !== 'DONE') {
      throw new Error('the archive that allowed this deletion is no longer valid');
    }
    const filter = {
      // 4.0: deletes only the organisation's screenshots, as its archive holds them.
      companyId: job.companyId ?? '00000000-0000-0000-0000-000000000000',
      from: monthStart(month, tz),
      to: monthStart(nextMonth(month), tz),
      createdBefore: archive.coveredUntil,
    };
    const watch = this.watcher(job.id);
    const total = await this.jobs.countShots(filter);
    await this.jobs.update(job.id, { total });
    let done = 0;
    const failedIds = new Set<string>();
    let after: { takenAt: Date; id: string } | null = null;
    for (;;) {
      await watch.check(true);
      // Rows that were deleted are gone from the next page; ones storage refused stay
      // behind and are stepped over.
      const page = await this.jobs.listShots(filter, { after, take: 1000 });
      if (!page.length) break;
      const res = await this.s3.deleteMany(page.map((s) => s.storageKey));
      const failedKeys = new Set(res.failed);
      const gone: string[] = [];
      for (const s of page) {
        if (failedKeys.has(s.storageKey)) failedIds.add(s.id);
        else gone.push(s.id);
      }
      done += await this.jobs.deleteShots(gone);
      watch.progress(done);
      const kept = page.filter((s) => failedIds.has(s.id));
      after = kept.length
        ? { takenAt: kept[kept.length - 1].takenAt, id: kept[kept.length - 1].id }
        : after;
      if (page.length < 1000 && !gone.length) break;
    }
    const failed = failedIds.size;
    await this.finish(job.id, failed ? 'FAILED' : 'DONE', {
      done,
      complete: !failed,
      error: failed
        ? `${failed} screenshot(s) could not be removed from storage. Try again.`
        : null,
    });
    this.logger.log(`deleted ${done} screenshot(s) of ${month} (${job.id})`);
  }
}
