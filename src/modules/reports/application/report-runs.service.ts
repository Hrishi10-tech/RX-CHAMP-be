import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { addDaysToKey, appTimezone, dateKeyInZone, startOfDayInZone } from '@shared/utils/timezone';
import { WORKTIME_READER, WorktimeReader } from '@modules/worktime/domain/worktime.reader';
import { monthlyReportCopy, NOTICE } from '@modules/worktime/domain/notice-copy';
import { monthDates } from '../domain/report-builder';
import { REPORT_STORE, ReportStore } from '../domain/report.store';
import { PersonMonthReport, ReportRunView } from '../domain/report.types';
import { ReportsService } from './reports.service';

/** The small summary a run keeps (the full report is always built live on opening). */
export function runSummary(persons: PersonMonthReport[]): Record<string, number> {
  const sum = (f: (p: PersonMonthReport) => number) => persons.reduce((s, p) => s + f(p), 0);
  return {
    people: persons.length,
    workdays: sum((p) => p.totals.workdays),
    full: sum((p) => p.totals.full),
    half: sum((p) => p.totals.half),
    absent: sum((p) => p.totals.absent),
    extra: sum((p) => p.totals.extra),
    focusSec: sum((p) => p.totals.focusSec),
    expectedSec: sum((p) => p.totals.expectedSec),
    lateStarts: sum((p) => p.totals.lateStarts),
    pending: sum((p) => p.totals.pending),
    quietHours: sum((p) => p.totals.quietHours),
    needsALook: persons.filter((p) => p.totals.needsALook).length,
  };
}

/** The catch-up waits this long after boot, so it never slows the start. */
const BOOT_CATCH_UP_DELAY_MS = 20_000;

const scopeOf = (role: string): 'TEAM' | 'ALL' => (role === 'SUPER_ADMIN' ? 'ALL' : 'TEAM');

/**
 * Monthly reports (SPEC 1.9): at 00:30 business time on the 1st the previous
 * month is built once for everyone; each active Manager gets a run for their
 * team and each active Super Admin one for everyone, with a MONTHLY_REPORT_READY
 * notice. Upserts by (month, scope, owner), so a rerun is harmless. A catch-up on
 * boot and at 01:00 daily makes the runs still missing for the previous month
 * (the API was down at 00:30, or the job failed), so it is idempotent.
 */
@Injectable()
export class ReportRunsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ReportRunsService.name);
  private running = false;
  private bootTimer: NodeJS.Timeout | null = null;
  private firstBootAt: Date | null = null;

  constructor(
    @Inject(REPORT_STORE) private readonly store: ReportStore,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly reports: ReportsService,
  ) {}

  /** The month before the one `now` is in, in business time (YYYY-MM). */
  static previousMonth(now: Date): string {
    const today = dateKeyInZone(now, appTimezone());
    return addDaysToKey(`${today.slice(0, 7)}-01`, -1).slice(0, 7);
  }

  onApplicationBootstrap(): void {
    // The first boot of 3.1 on this database is recorded once (see catchUp).
    void this.firstBoot(new Date()).catch((err: Error) =>
      this.logger.warn(`first boot not recorded: ${err.message}`),
    );
    if (process.env.NODE_ENV === 'test') return;
    this.bootTimer = setTimeout(() => void this.catchUp(), BOOT_CATCH_UP_DELAY_MS);
    this.bootTimer.unref?.();
  }

  /** When 3.1 first booted on this database (stored once, then cached). */
  private async firstBoot(now: Date): Promise<Date> {
    this.firstBootAt ??= await this.store.recordFirstBoot(now);
    return this.firstBootAt;
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  async list(me: AuthenticatedUser): Promise<{ items: ReportRunView[] }> {
    const rows = await this.store.listRuns(me.id);
    return {
      items: rows.map((r) => ({
        id: r.id,
        month: r.month,
        scope: r.scope,
        generatedAt: r.generatedAt.toISOString(),
        summary: r.summary,
      })),
    };
  }

  @Cron('30 0 1 * *', { name: 'monthly-report', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<void> {
    const month = ReportRunsService.previousMonth(now);
    await this.once(`monthly report ${month}`, () => this.generate(month, now));
  }

  /**
   * The previous month's runs for the owners still missing one. Nothing to do
   * when every owner has a run, nobody worked that month, or 3.1 first booted in
   * the current month: a month from before 3.1 ran (built from backfilled
   * history) is never announced. The 00:30 job on the 1st is not affected.
   */
  @Cron('0 1 * * *', { name: 'monthly-report-catch-up', timeZone: appTimezone() })
  async catchUp(now: Date = new Date()): Promise<void> {
    const month = ReportRunsService.previousMonth(now);
    await this.once(`monthly report catch-up ${month}`, async () => {
      const tz = appTimezone();
      const monthStart = startOfDayInZone(`${dateKeyInZone(now, tz).slice(0, 7)}-01`, tz);
      if ((await this.firstBoot(now)).getTime() >= monthStart.getTime()) return 0;
      const dates = monthDates(month);
      const worked = await this.reader.userIdsWithSessionsBetween(
        null,
        dates[0],
        dates[dates.length - 1],
      );
      return worked.size ? this.generate(month, now, true) : 0;
    });
  }

  /** One job at a time in this process; failures are logged, never thrown. */
  private async once(label: string, job: () => Promise<number>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const runs = await job();
      if (runs > 0) this.logger.log(`${label}: ${runs} run(s)`);
    } catch (err) {
      this.logger.warn(`${label} failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Builds the month once and stores every owner's run (only the owners with
   * no run for it yet, when `onlyMissing`); returns how many were stored.
   */
  async generate(month: string, now: Date, onlyMissing = false): Promise<number> {
    const everyone = await this.reader.listPeople({});
    const have = onlyMissing ? await this.store.runKeys(month) : new Set<string>();
    const owners = everyone.filter(
      (p) =>
        p.active &&
        (p.role === 'MANAGER' || p.role === 'SUPER_ADMIN') &&
        !have.has(`${scopeOf(p.role)}|${p.id}`),
    );
    if (!owners.length) return 0;
    const dates = monthDates(month);
    const worked = await this.reader.userIdsWithSessionsBetween(
      everyone.filter((p) => !p.active).map((p) => p.id),
      dates[0],
      dates[dates.length - 1],
    );
    const inMonth = everyone.filter((p) => p.active || worked.has(p.id));
    const built = await this.reports.buildMonth(inMonth, month, 'ALL', now);
    let runs = 0;
    for (const owner of owners) {
      const scope = scopeOf(owner.role);
      const persons =
        scope === 'ALL'
          ? built.persons
          : built.persons.filter((p) => p.person.managerId === owner.id);
      await this.store.upsertRun(month, scope, owner.id, runSummary(persons));
      const copy = monthlyReportCopy(month, scope);
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([owner.id], NOTICE.MONTHLY_REPORT_READY, copy.title, copy.body, null),
      );
      runs += 1;
    }
    return runs;
  }
}
