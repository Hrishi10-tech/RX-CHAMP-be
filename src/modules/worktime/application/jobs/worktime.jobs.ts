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
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
} from '@modules/shifts/domain/break-record.repository';
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

/** Each item once (an item can reach several approvers). */
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
  constructor(
    private readonly skips: SkipsService,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly breakRecords: BreakRecordRepository,
  ) {
    super();
  }

  @Cron('*/5 * * * *', { name: 'breaks-auto-skip', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<void> {
    await this.guarded('auto-skip', async () => {
      await this.skips.autoSkipAll(now);
      // 4.0: a paused break whose window has closed ends at its pause.
      const ended = await this.breakRecords.endExpiredPaused(now);
      if (ended) this.logger.log(`ended ${ended} paused break(s) whose window closed`);
    });
  }
}

/**
 * Who acts on approval items, resolved once per job run (docs/4.0/SPEC.md 1.3):
 * MANAGER items go to the Managers of the subject's department (the Admin when
 * the department has none); ADMIN items (and 3.x SUPER_ADMIN rows) go to the
 * organisation's Admin. Never across organisations, never to the subject.
 */
class Recipients {
  private readonly admins = new Map<string, Promise<string[]>>();
  private readonly managers = new Map<string, Promise<string[]>>();

  constructor(private readonly people: ShiftPeopleReader) {}

  orgAdmins(companyId: string | null): Promise<string[]> {
    if (!companyId) return Promise.resolve([]);
    let hit = this.admins.get(companyId);
    if (!hit) {
      hit = this.people.listOrgAdminIds(companyId);
      this.admins.set(companyId, hit);
    }
    return hit;
  }

  deptManagers(departmentId: string | null): Promise<string[]> {
    if (!departmentId) return Promise.resolve([]);
    let hit = this.managers.get(departmentId);
    if (!hit) {
      hit = this.people.listDepartmentManagerIds(departmentId);
      this.managers.set(departmentId, hit);
    }
    return hit;
  }

  /** The people an item waits for. */
  async approvers(c: {
    approverRole: string | null;
    companyId: string | null;
    departmentId: string | null;
    userId?: string;
  }): Promise<string[]> {
    let ids: string[] = [];
    if (c.approverRole === 'MANAGER') ids = await this.deptManagers(c.departmentId);
    if (!ids.length) ids = await this.orgAdmins(c.companyId);
    return ids.filter((id) => id !== c.userId);
  }
}

/**
 * Every 15 minutes (SPEC 1.7): one reminder per approver for what is due within
 * 12 hours, then escalation of what is past due: the approvers hear it is
 * overdue, and the organisation's Admin gets one notice per run naming them.
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
    // Rows an old (3.x) process wrote during the deploy window get their clock now,
    // from the shared defaults (only one organisation exists at that point).
    const filled = await this.reader.fillMissingDueAt((await this.settings.get()).approvalSlaHours);
    // 4.0: each organisation's own SLA in the wording.
    const slaCache = new Map<string, Promise<number>>();
    const slaOf = (companyId: string | null): Promise<number> => {
      const key = companyId ?? '-';
      let hit = slaCache.get(key);
      if (!hit) {
        hit = this.settings.get(companyId).then((x) => x.approvalSlaHours);
        slaCache.set(key, hit);
      }
      return hit;
    };
    if (filled) this.logger.log(`approvals: gave ${filled} pending item(s) a due time`);
    const who = new Recipients(this.people);
    let sent = 0;

    const reminders = await this.reader.remindersDue(now);
    const reminded: ApprovalRef[] = [];
    for (const [approverId, items] of await this.perApprover(reminders, who)) {
      const copy = dueSoonCopy(items.length);
      const n = await this.notify([approverId], NOTICE.APPROVALS_DUE_SOON, copy.title, copy.body);
      sent += n;
      if (n > 0) reminded.push(...items);
    }
    if (reminded.length) await this.reader.markReminded(unique(reminded), now);

    const escalated = await this.reader.escalationsDue(now);
    const marked: ApprovalRef[] = [];
    if (escalated.length) {
      // Managers' items: the managers hear it is overdue, then the Admin is told.
      const managerItems = escalated.filter((e) => e.approverRole === 'MANAGER');
      const toldManagers = new Set<string>();
      for (const [approverId, items] of await this.perApprover(managerItems, who)) {
        const copy = overdueCopy(items.length, await slaOf(items[0]?.companyId ?? null));
        const n = await this.notify([approverId], NOTICE.APPROVALS_OVERDUE, copy.title, copy.body);
        sent += n;
        if (n > 0) for (const i of items) toldManagers.add(`${i.type}:${i.id}`);
      }
      // Per organisation: its Admin gets one escalation naming the managers.
      const byOrg = new Map<string, SlaClaim[]>();
      for (const e of escalated) {
        const key = e.companyId ?? '-';
        byOrg.set(key, [...(byOrg.get(key) ?? []), e]);
      }
      for (const [companyId, items] of byOrg) {
        const admins = (await who.orgAdmins(companyId === '-' ? null : companyId)).filter(
          (id) => !items.every((i) => i.userId === id),
        );
        const managerIds = new Set<string>();
        for (const i of items) {
          if (i.approverRole === 'MANAGER') {
            for (const m of await who.deptManagers(i.departmentId)) managerIds.add(m);
          }
        }
        const managers = await this.people.findAnyByIds([...managerIds]);
        const copy = escalatedCopy(
          items.length,
          await slaOf(companyId === '-' ? null : companyId),
          managers.map((p) => personName(p)),
        );
        const n = await this.notify(admins, NOTICE.APPROVALS_ESCALATED, copy.title, copy.body);
        sent += n;
        // Escalated means the Admin was told: then every item counts. Without an
        // Admin, the managers' overdue notice is all there is.
        if (n > 0) marked.push(...items);
        else if (!admins.length)
          marked.push(...items.filter((i) => toldManagers.has(`${i.type}:${i.id}`)));
      }
    }
    if (marked.length) await this.reader.markEscalated(unique(marked), now);
    if (reminded.length || marked.length) {
      this.logger.log(`approvals: ${reminded.length} reminded, ${unique(marked).length} escalated`);
    }
    return sent;
  }

  /** Items per approver. */
  private async perApprover(claims: SlaClaim[], who: Recipients): Promise<Map<string, SlaClaim[]>> {
    const out = new Map<string, SlaClaim[]>();
    for (const c of claims) {
      for (const id of await who.approvers(c)) out.set(id, [...(out.get(id) ?? []), c]);
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
 * breaks, meetings and away time together, per organisation (4.0).
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
    const who = new Recipients(this.people);
    for (const g of groups) {
      for (const id of await who.approvers(g)) add(id, g);
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
