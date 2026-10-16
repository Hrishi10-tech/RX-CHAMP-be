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
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { personName } from '@modules/shifts/application/break-events.service';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import {
  APPROVALS_READER,
  ApprovalRef,
  ApprovalsReader,
  SlaClaim,
} from '../../domain/approvals.reader';
import { ApprovalsDigestEvent } from '../../domain/events/approvals-digest.event';
import { dueSoonCopy, escalatedCopy, NOTICE, overdueCopy } from '../../domain/notice-copy';
import { DayDataService } from '../day-data.service';
import { SkipsService } from '../skips.service';
import { WorkSessionsService } from '../work-sessions.service';

/** Each item once (an item can reach several Super Admins). */
function unique(refs: ApprovalRef[]): ApprovalRef[] {
  const seen = new Map<string, ApprovalRef>();
  for (const r of refs) seen.set(`${r.type}:${r.id}`, { type: r.type, id: r.id });
  return [...seen.values()];
}

/** When the daily digest goes out, business time. Override with BREAK_DIGEST_CRON. */
export const BREAK_DIGEST_CRON = process.env.BREAK_DIGEST_CRON || '30 18 * * *';

/**
 * Runs `work` once at a time; a run that overlaps the previous one is skipped.
 * Errors are logged and swallowed: a job never throws (SPEC 3.11).
 */
abstract class GuardedJob {
  protected abstract readonly logger: Logger;
  private running = false;

  protected async guarded(name: string, work: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.logger.warn(`${name}: previous run still in progress, skipped`);
      return;
    }
    this.running = true;
    try {
      await work();
    } catch (err) {
      this.logger.warn(`${name} failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

/** The hourly cache is warmed this long after boot, after the API is serving. */
const HOURLY_WARM_DELAY_MS = 45_000;

/**
 * Nightly at 03:10, and once after boot: the settled hour buckets of this month
 * and last month go into memory (DayDataService), so month views only aggregate
 * their last few days of samples.
 */
@Injectable()
export class HourlyCacheJob extends GuardedJob implements OnApplicationBootstrap, OnModuleDestroy {
  protected readonly logger = new Logger(HourlyCacheJob.name);
  private bootTimer: NodeJS.Timeout | null = null;

  constructor(private readonly dayData: DayDataService) {
    super();
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.bootTimer = setTimeout(() => void this.run(), HOURLY_WARM_DELAY_MS);
    this.bootTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.bootTimer) clearTimeout(this.bootTimer);
    this.bootTimer = null;
  }

  @Cron('10 3 * * *', { name: 'hourly-cache-warm', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<void> {
    await this.guarded('hourly cache', async () => {
      const added = await this.dayData.warmSettled(now);
      if (added > 0) this.logger.log(`hourly cache: ${added} settled day(s) added`);
    });
  }
}

/** Every 10 minutes: close sessions nobody ended (SPEC 1.2). */
@Injectable()
export class AutoCloseJob extends GuardedJob {
  protected readonly logger = new Logger(AutoCloseJob.name);
  constructor(private readonly sessions: WorkSessionsService) {
    super();
  }

  @Cron('*/10 * * * *', { name: 'work-sessions-auto-close', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<void> {
    await this.guarded('auto-close', async () => {
      await this.sessions.autoCloseAll(now);
    });
  }
}

/** Every 5 minutes: owed breaks with a closed window become AUTO_SKIPPED (SPEC 1.4). */
@Injectable()
export class AutoSkipJob extends GuardedJob {
  protected readonly logger = new Logger(AutoSkipJob.name);
  constructor(private readonly skips: SkipsService) {
    super();
  }

  @Cron('*/5 * * * *', { name: 'breaks-auto-skip', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<void> {
    await this.guarded('auto-skip', async () => {
      await this.skips.autoSkipAll(now);
    });
  }
}

/**
 * Every 15 minutes (SPEC 1.7): one reminder per approver for what is due within
 * 12 hours, then escalation of what is past due: the approver hears it is
 * overdue, and every Super Admin gets one notice per run naming the approvers.
 * Notices go out first and only the items they reached are then marked reminded
 * or escalated (once, by a conditional update), so a failed notice is retried by
 * the next run. Runs never overlap in one process.
 */
@Injectable()
export class ApprovalsSlaJob extends GuardedJob {
  protected readonly logger = new Logger(ApprovalsSlaJob.name);
  constructor(
    @Inject(APPROVALS_READER) private readonly reader: ApprovalsReader,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly settings: AppSettingsService,
  ) {
    super();
  }

  @Cron('*/15 * * * *', { name: 'approvals-sla', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<void> {
    await this.guarded('approvals-sla', async () => {
      await this.tick(now);
    });
  }

  /**
   * One pass; returns how many notices went out (for tests and logs). Notices go
   * out first; only the items they actually covered are then marked reminded or
   * escalated, so a failed notice is retried by the next run.
   */
  async tick(now: Date): Promise<number> {
    const sla = (await this.settings.get()).approvalSlaHours;
    // Rows an old process wrote during the deploy window get their clock now.
    const filled = await this.reader.fillMissingDueAt(sla);
    if (filled) this.logger.log(`approvals: gave ${filled} pending item(s) a due time`);
    const superAdmins = await this.people.listSuperAdminIds();
    let sent = 0;

    const reminders = await this.reader.remindersDue(now);
    const reminded: ApprovalRef[] = [];
    for (const [approverId, items] of this.perApprover(reminders, superAdmins)) {
      const copy = dueSoonCopy(items.length);
      const n = await this.notify([approverId], NOTICE.APPROVALS_DUE_SOON, copy.title, copy.body);
      sent += n;
      if (n > 0) reminded.push(...items);
    }
    if (reminded.length) await this.reader.markReminded(unique(reminded), now);

    const escalated = await this.reader.escalationsDue(now);
    const marked: ApprovalRef[] = [];
    if (escalated.length) {
      const direct = new Map<string, SlaClaim[]>();
      for (const e of escalated) {
        if (e.approverId) direct.set(e.approverId, [...(direct.get(e.approverId) ?? []), e]);
      }
      const toldApprover: SlaClaim[] = [];
      for (const [approverId, items] of direct) {
        const copy = overdueCopy(items.length, sla);
        const n = await this.notify([approverId], NOTICE.APPROVALS_OVERDUE, copy.title, copy.body);
        sent += n;
        if (n > 0) toldApprover.push(...items);
      }
      const approvers = await this.people.findAnyByIds([...direct.keys()]);
      const copy = escalatedCopy(
        escalated.length,
        sla,
        approvers.map((p) => personName(p)),
      );
      const n = await this.notify(superAdmins, NOTICE.APPROVALS_ESCALATED, copy.title, copy.body);
      sent += n;
      // Escalated means the Super Admins were told: then every item counts. If their
      // notice failed, nothing is marked and the next run tries again (with no Super
      // Admin at all, the approver's own notice is all there is).
      if (n > 0) marked.push(...escalated);
      else if (!superAdmins.length) marked.push(...toldApprover);
    }
    if (marked.length) await this.reader.markEscalated(unique(marked), now);
    if (reminded.length || marked.length) {
      this.logger.log(`approvals: ${reminded.length} reminded, ${unique(marked).length} escalated`);
    }
    return sent;
  }

  /** Items per approver, the Super Admin pool expanded to every Super Admin. */
  private perApprover(claims: SlaClaim[], superAdmins: string[]): Map<string, SlaClaim[]> {
    const out = new Map<string, SlaClaim[]>();
    const add = (id: string, c: SlaClaim) => out.set(id, [...(out.get(id) ?? []), c]);
    for (const c of claims) {
      if (c.approverId) add(c.approverId, c);
      else if (c.approverRole === 'SUPER_ADMIN') {
        for (const id of superAdmins) if (id !== c.userId) add(id, c);
      }
    }
    return out;
  }

  /** Publishes to the recipients who can still act on it; how many got it (0 on failure). */
  private async notify(ids: string[], type: string, title: string, body: string): Promise<number> {
    if (!ids.length) return 0;
    try {
      const active = (await this.people.findMany({ ids })).map((p) => p.id);
      if (!active.length) return 0;
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(active, type, title, body, null),
      );
      return active.length;
    } catch (err) {
      this.logger.warn(`${type} notice failed: ${(err as Error).message}`);
      return 0;
    }
  }
}

/**
 * The daily nudge (18:30 business time): every approver with something waiting
 * gets one notification with pending, due within 24 hours and overdue counts,
 * breaks and meetings together. Moved here from the shifts module in 3.1.
 */
@Injectable()
export class ApprovalsDigestJob extends GuardedJob {
  protected readonly logger = new Logger(ApprovalsDigestJob.name);
  constructor(
    @Inject(APPROVALS_READER) private readonly reader: ApprovalsReader,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {
    super();
  }

  @Cron(BREAK_DIGEST_CRON, { name: 'break-approvals-digest', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<void> {
    await this.guarded('approvals digest', async () => {
      const sent = await this.send(now);
      if (sent > 0) this.logger.log(`approvals digest sent to ${sent} approver(s)`);
    });
  }

  /** Builds and publishes the digests; returns how many people got one. */
  async send(now: Date): Promise<number> {
    const date = dateKeyInZone(now, appTimezone());
    const groups = await this.reader.digestCounts(now);
    if (!groups.length) return 0;
    const per = new Map<string, { pending: number; dueSoon: number; overdue: number }>();
    const add = (id: string, g: { pending: number; dueSoon: number; overdue: number }) => {
      const cur = per.get(id) ?? { pending: 0, dueSoon: 0, overdue: 0 };
      cur.pending += g.pending;
      cur.dueSoon += g.dueSoon;
      cur.overdue += g.overdue;
      per.set(id, cur);
    };
    let superAdmins: string[] | null = null;
    for (const g of groups) {
      if (g.approverId) add(g.approverId, g);
      else if (g.approverRole === 'SUPER_ADMIN') {
        superAdmins ??= await this.people.listSuperAdminIds();
        for (const id of superAdmins) add(id, g);
      }
    }
    const active = new Set((await this.people.findMany({ ids: [...per.keys()] })).map((p) => p.id));
    let sent = 0;
    for (const [id, c] of per) {
      if (!active.has(id) || c.pending === 0) continue;
      await this.events.publish(
        ApprovalsDigestEvent.eventName,
        new ApprovalsDigestEvent(id, c.pending, c.dueSoon, c.overdue, date),
      );
      sent += 1;
    }
    return sent;
  }
}
