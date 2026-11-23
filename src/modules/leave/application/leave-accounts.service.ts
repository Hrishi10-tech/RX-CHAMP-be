import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import {
  AccountPerson,
  balancesFrom,
  firstLeaveYear,
  grantOf,
  missingAccounts,
  spendableUnits,
  YearBalance,
} from '../domain/balance';
import { leaveAdjustedCopy, leaveQuotaCopy, LEAVE_NOTICE } from '../domain/leave-copy';
import { POLICY_BOUNDS, policyGrantUnits } from '../domain/leave-policy';
import {
  AccountUpdate,
  LEAVE_REPOSITORY,
  LeaveAccountRecord,
  LeaveAdjustmentRecord,
  LeaveQuotaRecord,
  LeaveRepository,
  LeaveRequestRecord,
  LeaveTx,
} from '../domain/leave.repository';
import {
  CATEGORY_LABEL,
  CATEGORY_NAME,
  daysOf,
  formatDays,
  isPool,
  kindLabel,
  POOL_CATEGORIES,
  PoolCategory,
  unitsOfDays,
} from '../domain/leave.types';
import { leaveSpan } from '../domain/request-rules';
import { fullName, LeavePeopleService } from './leave-people.service';
import { LeavePolicyService, LivePolicy } from './leave-policy.service';
import {
  CategoryBalanceView,
  LeaveAdjustmentView,
  LedgerLine,
  PersonBalanceRow,
} from './leave.views';

export const ADJUST_REASON_MIN = 5;
export const ADJUST_REASON_MAX = 300;
export const ADJUST_MAX_DAYS = 365;

export type Balances = Record<PoolCategory, Map<number, YearBalance>>;

export interface AdjustInput {
  userId: string;
  category: unknown;
  year?: unknown;
  mode: unknown;
  days: unknown;
  reason: unknown;
}

export function quotaMap(rows: readonly LeaveQuotaRecord[]): Partial<Record<PoolCategory, number>> {
  const out: Partial<Record<PoolCategory, number>> = {};
  for (const q of rows) out[q.category] = q.unitsPerYear;
  return out;
}

function thisYearOf(now: Date): number {
  return Number(dateKeyInZone(now, appTimezone()).slice(0, 4));
}

/** One pool's balance for one year as the API shows it. */
export function categoryView(
  category: PoolCategory,
  year: number,
  b: YearBalance | undefined,
  account: LeaveAccountRecord | undefined,
  opts: { carryUsable: boolean; policy: LivePolicy },
): CategoryBalanceView {
  const zero: YearBalance = {
    year,
    category,
    grantedUnits: 0,
    carriedUnits: 0,
    lapsedUnits: 0,
    adjustedUnits: 0,
    takenUnits: 0,
    pendingUnits: 0,
    balanceUnits: 0,
    availableUnits: 0,
  };
  const x = b ?? zero;
  return {
    category,
    label: CATEGORY_LABEL[category],
    name: CATEGORY_NAME[category],
    year,
    grantedDays: daysOf(x.grantedUnits),
    grantSource: account?.grantSource ?? 'DEFAULT',
    prorated: account?.prorated ?? false,
    carriedDays: daysOf(x.carriedUnits),
    lapsedDays: daysOf(x.lapsedUnits),
    adjustedDays: daysOf(x.adjustedUnits),
    takenDays: daysOf(x.takenUnits),
    pendingDays: daysOf(x.pendingUnits),
    balanceDays: daysOf(x.balanceUnits),
    availableDays: daysOf(x.availableUnits),
    spendableDays: daysOf(b ? spendableUnits(x, opts.carryUsable) : 0),
    yearEnd: category === 'CLSL' ? 'LAPSES' : 'CARRIES',
    carryCapDays: category === 'ELPL' ? opts.policy.elplCarryCapDays : 0,
  };
}

/**
 * Leave accounts and balances (3.4): one account per person, pool and year, opened
 * when first needed; quotas per person; manual adjustments by the Super Manager and
 * Super Admins; and the ledger a person reads.
 */
@Injectable()
export class LeaveAccountsService {
  private readonly logger = new Logger(LeaveAccountsService.name);

  constructor(
    @Inject(LEAVE_REPOSITORY) private readonly repo: LeaveRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly policies: LeavePolicyService,
    private readonly people: LeavePeopleService,
  ) {}

  /**
   * Inside a person's lock: opens any missing account up to `upToYear` (never
   * before their first leave year), then works out every balance.
   */
  async balancesIn(
    tx: LeaveTx,
    userId: string,
    upToYear: number,
    policy: LivePolicy,
    joinDate: string,
  ): Promise<{ balances: Balances; accounts: LeaveAccountRecord[] }> {
    const [existing, quotas] = await Promise.all([tx.accounts(userId), tx.quotas(userId)]);
    const person: AccountPerson = { userId, joinDate, quotas: quotaMap(quotas) };
    const missing = missingAccounts(
      person,
      existing,
      upToYear,
      LeavePolicyService.accountPolicy(policy),
    );
    if (missing.length) await tx.createAccounts(missing);
    const accounts = missing.length ? await tx.accounts(userId) : existing;
    const sums = await tx.sums(userId);
    return { balances: balancesFrom(accounts, sums), accounts };
  }

  /** A person's balances for one year (opening accounts as needed). */
  async balancesOf(
    userId: string,
    year: number,
    now: Date,
  ): Promise<{ balances: Balances; accounts: LeaveAccountRecord[]; policy: LivePolicy }> {
    const policy = await this.policies.forUser(userId, now);
    const joinDate = await this.people.joinDate(userId);
    const upTo = Math.max(year, thisYearOf(now));
    const r = await this.repo.inUserLock(userId, (tx) =>
      this.balancesIn(tx, userId, upTo, policy, joinDate),
    );
    return { ...r, policy };
  }

  views(
    year: number,
    balances: Balances,
    accounts: LeaveAccountRecord[],
    policy: LivePolicy,
    now: Date,
  ): CategoryBalanceView[] {
    const carryUsable = year <= thisYearOf(now);
    return POOL_CATEGORIES.map((c) =>
      categoryView(
        c,
        year,
        balances[c].get(year),
        accounts.find((a) => a.year === year && a.category === c),
        { carryUsable, policy },
      ),
    );
  }

  /** Everyone's balances for one year (the Balances page). Accounts are opened in bulk. */
  async rows(people: ShiftPerson[], year: number, now: Date): Promise<PersonBalanceRow[]> {
    if (!people.length) return [];
    const policyOf = await this.policies.forPeople(people, now);
    const ids = people.map((p) => p.id);
    const thisYear = thisYearOf(now);
    const [joins, quotas, existing] = await Promise.all([
      this.people.joinDates(ids),
      this.repo.quotasOf(ids),
      this.repo.accountsOf(ids),
    ]);
    const missing = people.flatMap((p) =>
      missingAccounts(
        {
          userId: p.id,
          joinDate: joins.get(p.id) ?? `${thisYear}-01-01`,
          quotas: quotaMap(quotas.filter((q) => q.userId === p.id)),
        },
        existing.filter((a) => a.userId === p.id),
        Math.max(year, thisYear),
        LeavePolicyService.accountPolicy(policyOf(p)),
      ),
    );
    if (missing.length) await this.repo.createAccounts(missing);
    const [accounts, sums, refs, held] = await Promise.all([
      missing.length ? this.repo.accountsOf(ids) : Promise.resolve(existing),
      this.repo.sumsOf(ids),
      this.people.refs(ids),
      this.repo.heldDaysOf(ids, dateKeyInZone(now, appTimezone()), `${year}-12-31`),
    ]);
    return people.map((p) => {
      const mine = accounts.filter((a) => a.userId === p.id);
      const balances = balancesFrom(mine, sums.get(p.id) ?? []);
      const [clsl, elpl] = this.views(year, balances, mine, policyOf(p), now);
      const q = quotaMap(quotas.filter((x) => x.userId === p.id));
      return {
        user: refs.get(p.id)!,
        year,
        clsl,
        elpl,
        quota: {
          clslDaysPerYear: q.CLSL !== undefined ? daysOf(q.CLSL) : null,
          elplDaysPerYear: q.ELPL !== undefined ? daysOf(q.ELPL) : null,
        },
        upcomingDays: daysOf(
          held
            .filter((h) => h.userId === p.id && h.date.startsWith(`${year}-`))
            .reduce((n, h) => n + h.units, 0),
        ),
      };
    });
  }

  /** The year's ledger of one person: grants, carry-over, adjustments, leave. */
  async ledger(
    userId: string,
    year: number,
    balances: Balances,
    accounts: LeaveAccountRecord[],
    requests: LeaveRequestRecord[],
  ): Promise<LedgerLine[]> {
    const adjustments = await this.repo.adjustmentsOf({ userId, year, limit: 500 });
    const names = await this.people.any(adjustments.map((a) => a.createdById));
    const tz = appTimezone();
    const lines: LedgerLine[] = [];
    for (const category of POOL_CATEGORIES) {
      const b = balances[category].get(year);
      const account = accounts.find((a) => a.year === year && a.category === category);
      if (!b || !account) continue;
      const opened = dateKeyInZone(account.createdAt, tz);
      lines.push({
        date: account.prorated && opened > `${year}-01-01` ? opened : `${year}-01-01`,
        kind: 'GRANT',
        category,
        days: daysOf(b.grantedUnits),
        text:
          `${CATEGORY_LABEL[category]} for ${year}` +
          (account.prorated ? ', pro rata from the day you joined' : '') +
          (account.grantSource === 'PERSON' ? ' (own yearly quota)' : ''),
        byName: null,
        requestId: null,
        at: null,
      });
      if (category === 'ELPL' && (b.carriedUnits !== 0 || b.lapsedUnits > 0)) {
        lines.push({
          date: `${year}-01-01`,
          kind: 'CARRY',
          category,
          days: daysOf(b.carriedUnits),
          text:
            `Carried over from ${year - 1}` +
            (b.lapsedUnits > 0 ? `; ${formatDays(b.lapsedUnits)} over the cap lapsed` : ''),
          byName: null,
          requestId: null,
          at: null,
        });
      }
    }
    for (const a of adjustments) {
      lines.push({
        date: dateKeyInZone(a.createdAt, tz),
        kind: a.mode === 'QUOTA' ? 'QUOTA' : 'ADJUSTMENT',
        category: a.category,
        days: daysOf(a.deltaUnits),
        text: a.mode === 'SET' ? `Set to ${formatDays(a.targetUnits ?? 0)}: ${a.reason}` : a.reason,
        byName: fullName(names.get(a.createdById)),
        requestId: null,
        at: a.createdAt.toISOString(),
      });
    }
    for (const r of requests) {
      if (r.year !== year || (r.status !== 'APPROVED' && r.status !== 'PENDING')) continue;
      // Comp off has its own history (credits and what drew on them, 3.5).
      if (r.category === 'COMPOFF') continue;
      lines.push({
        date: r.startDate,
        kind: r.status === 'APPROVED' ? 'LEAVE' : 'PENDING',
        category: r.category,
        days: -daysOf(r.units),
        text:
          `${leaveSpan(r.startDate, r.endDate)}, ${kindLabel(r.kind, r.part).toLowerCase()}` +
          (r.status === 'PENDING' ? ' (waiting for approval)' : ''),
        byName: null,
        requestId: r.id,
        at: null,
      });
    }
    const order: Record<LedgerLine['kind'], number> = {
      GRANT: 0,
      CARRY: 1,
      QUOTA: 2,
      ADJUSTMENT: 3,
      LEAVE: 4,
      PENDING: 5,
    };
    return lines.sort((x, y) => x.date.localeCompare(y.date) || order[x.kind] - order[y.kind]);
  }

  /** 4.0: the organisation's admins and the Super Manager, for people they see, never their own. */
  private assertMayAdjust(me: AuthenticatedUser, target: ShiftPerson): void {
    if (me.role !== Role.SUPER_ADMIN && me.role !== Role.ADMIN && me.role !== Role.SUPER_MANAGER) {
      throw new ForbiddenError(
        'Only the organisation admin and the Super Manager can change leave balances.',
      );
    }
    if (target.id === me.id) {
      throw new ForbiddenError('You cannot change your own leave. Ask your organisation admin.');
    }
    if (!this.people.canSee(me, target)) throw new NotFoundError('Unknown person');
  }

  /** POST /leave/adjustments: add, take off, or set a balance, with a reason the person reads. */
  async adjust(
    me: AuthenticatedUser,
    input: AdjustInput,
    now: Date,
  ): Promise<LeaveAdjustmentRecord> {
    const target = (await this.people.any([input.userId])).get(input.userId);
    if (!target) throw new NotFoundError('Unknown person');
    this.assertMayAdjust(me, target);
    if (!isPool(input.category)) {
      throw new ValidationError(
        input.category === 'COMPOFF'
          ? 'Comp off is credited from the Comp off tab, not changed here.'
          : 'Pick CL/SL or EL/PL.',
      ).withDetails({ field: 'category' });
    }
    const category = input.category;
    const mode = input.mode;
    if (mode !== 'ADD' && mode !== 'SUBTRACT' && mode !== 'SET') {
      throw new ValidationError('Pick add, take off or set.').withDetails({ field: 'mode' });
    }
    const units = unitsOfDays(input.days);
    const positive = mode !== 'SET';
    if (units === null || (positive ? units <= 0 : units < 0) || units > ADJUST_MAX_DAYS * 4) {
      throw new ValidationError(
        positive
          ? `Give the days, more than 0 and at most ${ADJUST_MAX_DAYS}, in quarter days (0.25, 0.5, 0.75).`
          : `Give the balance, 0 to ${ADJUST_MAX_DAYS} days, in quarter days (0.25, 0.5, 0.75).`,
      ).withDetails({ field: 'days' });
    }
    const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
    if (reason.length < ADJUST_REASON_MIN || reason.length > ADJUST_REASON_MAX) {
      throw new ValidationError(
        `Give a reason the person will read, ${ADJUST_REASON_MIN} to ${ADJUST_REASON_MAX} characters.`,
      ).withDetails({ field: 'reason' });
    }
    const thisYear = thisYearOf(now);
    const year = input.year === undefined || input.year === null ? thisYear : Number(input.year);
    if (!Number.isInteger(year) || year < thisYear - 1 || year > thisYear + 1) {
      throw new ValidationError(
        `The year must be ${thisYear - 1}, ${thisYear} or ${thisYear + 1}.`,
      ).withDetails({ field: 'year' });
    }
    const policy = await this.policies.get(target.companyId, now);
    const joinDate = await this.people.joinDate(target.id);
    if (year < firstLeaveYear(joinDate, policy.startedOn)) {
      throw new ValidationError(
        `${fullName(target)} has no leave in ${year}: their leave starts in ${firstLeaveYear(joinDate, policy.startedOn)}.`,
      ).withDetails({ field: 'year' });
    }

    const { saved, balanceUnits } = await this.repo.inUserLock(target.id, async (tx) => {
      const { balances } = await this.balancesIn(
        tx,
        target.id,
        Math.max(year, thisYear),
        policy,
        joinDate,
      );
      const b = balances[category].get(year)!;
      const delta = mode === 'ADD' ? units : mode === 'SUBTRACT' ? -units : units - b.balanceUnits;
      if (delta === 0) {
        throw new ConflictError(
          `${fullName(target)}'s ${CATEGORY_LABEL[category]} for ${year} is already ${formatDays(b.balanceUnits)}.`,
          'NO_CHANGE',
        );
      }
      const row = await tx.insertAdjustment({
        userId: target.id,
        year,
        category,
        deltaUnits: delta,
        mode,
        targetUnits: mode === 'SET' ? units : null,
        reason,
        createdById: me.id,
      });
      return { saved: row, balanceUnits: b.balanceUnits + delta };
    });
    this.logger.log(
      `leave ${category} ${year} of ${target.id} ${mode} ${formatDays(saved.deltaUnits, { signed: true })} by ${me.id}`,
    );
    if (target.id !== me.id) {
      const by = (await this.people.any([me.id])).get(me.id);
      const copy = leaveAdjustedCopy({
        category,
        year,
        mode,
        deltaUnits: saved.deltaUnits,
        targetUnits: saved.targetUnits,
        byName: fullName(by),
        reason,
        balanceUnits,
      });
      await this.tell([target.id], LEAVE_NOTICE.LEAVE_ADJUSTED, copy.title, copy.body, me.id);
    }
    return saved;
  }

  /**
   * PUT /leave/quotas/:userId: a person's own yearly days of a pool (null: back to
   * the policy's). This year's account and any later one follow at once.
   */
  async setQuota(
    me: AuthenticatedUser,
    userId: string,
    body: { clslDaysPerYear?: unknown; elplDaysPerYear?: unknown },
    now: Date,
  ): Promise<void> {
    const target = (await this.people.any([userId])).get(userId);
    if (!target) throw new NotFoundError('Unknown person');
    this.assertMayAdjust(me, target);
    const wanted: { category: PoolCategory; units: number | null }[] = [];
    for (const [field, category] of [
      ['clslDaysPerYear', 'CLSL'],
      ['elplDaysPerYear', 'ELPL'],
    ] as const) {
      const v = body[field];
      if (v === undefined) continue;
      if (v === null) {
        wanted.push({ category, units: null });
        continue;
      }
      const units = unitsOfDays(v);
      const b = POLICY_BOUNDS.clslDaysPerYear;
      if (units === null || units < b.min * 4 || units > b.max * 4) {
        throw new ValidationError(
          `${CATEGORY_LABEL[category]} a year must be ${b.min} to ${b.max} days, in quarter days.`,
        ).withDetails({ field });
      }
      wanted.push({ category, units });
    }
    if (!wanted.length) {
      throw new ValidationError(
        'Send clslDaysPerYear or elplDaysPerYear (null: the default).',
      ).withDetails({
        field: 'clslDaysPerYear',
      });
    }
    const policy = await this.policies.forUser(userId, now);
    const joinDate = await this.people.joinDate(userId);
    const thisYear = thisYearOf(now);
    const changes = await this.repo.inUserLock(userId, async (tx) => {
      const before = quotaMap(await tx.quotas(userId));
      const done: { category: PoolCategory; fromUnits: number; toUnits: number }[] = [];
      for (const w of wanted) {
        const fromUnits = before[w.category] ?? policyGrantUnits(policy, w.category);
        const toUnits = w.units ?? policyGrantUnits(policy, w.category);
        const same =
          w.units === null ? before[w.category] === undefined : before[w.category] === w.units;
        if (same) continue;
        await tx.setQuota(userId, w.category, w.units, me.id);
        await tx.insertAdjustment({
          userId,
          year: thisYear,
          category: w.category,
          deltaUnits: 0,
          mode: 'QUOTA',
          targetUnits: toUnits,
          reason:
            w.units === null
              ? `Yearly ${CATEGORY_LABEL[w.category]} back to the default, ${formatDays(toUnits)}`
              : `Yearly ${CATEGORY_LABEL[w.category]} set to ${formatDays(toUnits)} (was ${formatDays(fromUnits)})`,
          createdById: me.id,
        });
        done.push({ category: w.category, fromUnits, toUnits });
      }
      if (!done.length) return done;
      // Open what is missing, then re-grant this year and later ones.
      await this.balancesIn(tx, userId, thisYear, policy, joinDate);
      const person: AccountPerson = { userId, joinDate, quotas: quotaMap(await tx.quotas(userId)) };
      const ap = LeavePolicyService.accountPolicy(policy);
      for (const a of await tx.accounts(userId)) {
        if (a.year < thisYear || !done.some((d) => d.category === a.category)) continue;
        const g = grantOf(person, a.year, a.category, ap);
        if (
          g.grantedUnits !== a.grantedUnits ||
          g.grantSource !== a.grantSource ||
          g.prorated !== a.prorated
        ) {
          await tx.updateAccount(a.id, g);
        }
      }
      return done;
    });
    if (!changes.length) return;
    this.logger.log(
      `leave quota of ${userId} changed by ${me.id}: ${changes.map((c) => c.category).join(', ')}`,
    );
    if (userId !== me.id) {
      const by = fullName((await this.people.any([me.id])).get(me.id));
      for (const c of changes) {
        const copy = leaveQuotaCopy({ ...c, byName: by, year: thisYear });
        await this.tell([userId], LEAVE_NOTICE.LEAVE_ADJUSTED, copy.title, copy.body, me.id);
      }
    }
  }

  /**
   * After a policy change: accounts follow the new yearly days, pro rata rule and
   * carry-over cap. Years not started yet always follow; this year only when asked.
   */
  async applyPolicy(
    before: LivePolicy,
    after: LivePolicy,
    applyNow: boolean,
    now: Date,
  ): Promise<number> {
    const grantChanged =
      policyGrantUnits(before, 'CLSL') !== policyGrantUnits(after, 'CLSL') ||
      policyGrantUnits(before, 'ELPL') !== policyGrantUnits(after, 'ELPL') ||
      before.prorateJoiners !== after.prorateJoiners;
    const capChanged = before.elplCarryCapDays !== after.elplCarryCapDays;
    // "Apply to this year" brings this year in line with the policy as it stands,
    // whether or not this change touched the grant (it may have been saved before).
    if (!grantChanged && !capChanged && !applyNow) return 0;
    const thisYear = thisYearOf(now);
    const accounts = await this.repo.accountsFromYear(applyNow ? thisYear : thisYear + 1);
    if (!accounts.length) return 0;
    const ids = [...new Set(accounts.map((a) => a.userId))];
    const [joins, quotas] = await Promise.all([
      this.people.joinDates(ids),
      this.repo.quotasOf(ids),
    ]);
    const ap = LeavePolicyService.accountPolicy(after);
    const updates: AccountUpdate[] = [];
    for (const a of accounts) {
      const person: AccountPerson = {
        userId: a.userId,
        joinDate: joins.get(a.userId) ?? `${a.year}-01-01`,
        quotas: quotaMap(quotas.filter((q) => q.userId === a.userId)),
      };
      const u: AccountUpdate = { id: a.id };
      if (grantChanged || applyNow) {
        const g = grantOf(person, a.year, a.category, ap);
        if (g.grantedUnits !== a.grantedUnits || g.prorated !== a.prorated) Object.assign(u, g);
      }
      if (
        (capChanged || applyNow) &&
        a.category === 'ELPL' &&
        a.carryCapUnits !== ap.carryCapUnits
      ) {
        u.carryCapUnits = ap.carryCapUnits;
      }
      if (Object.keys(u).length > 1) updates.push(u);
    }
    for (let i = 0; i < updates.length; i += 200)
      await this.repo.updateAccounts(updates.slice(i, i + 200));
    if (updates.length) this.logger.log(`leave policy applied to ${updates.length} accounts`);
    return updates.length;
  }

  /** GET /leave/adjustments: the trail (Manager: own team; Super Manager, Super Admin: everyone). */
  async trail(
    me: AuthenticatedUser,
    q: { userId?: string; year?: number; companyId?: string; limit?: number },
  ): Promise<LeaveAdjustmentView[]> {
    const scope = await this.people.scopeIds(me, { companyId: q.companyId });
    if (q.userId && scope && !scope.includes(q.userId)) return [];
    const rows = await this.repo.adjustmentsOf({
      userId: q.userId,
      userIds: q.userId ? undefined : scope,
      year: q.year,
      limit: q.limit ?? 200,
    });
    return this.adjustmentViews(rows);
  }

  async adjustmentViews(rows: LeaveAdjustmentRecord[]): Promise<LeaveAdjustmentView[]> {
    const people = await this.people.any(rows.flatMap((r) => [r.userId, r.createdById]));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: fullName(people.get(r.userId)),
      companyName: people.get(r.userId)?.companyName ?? null,
      year: r.year,
      category: r.category,
      categoryLabel: CATEGORY_LABEL[r.category],
      mode: r.mode,
      days: daysOf(r.deltaUnits),
      label:
        r.mode === 'SET'
          ? `Set to ${formatDays(r.targetUnits ?? 0)}`
          : r.mode === 'QUOTA'
            ? `Yearly ${formatDays(r.targetUnits ?? 0)}`
            : formatDays(r.deltaUnits, { signed: true }),
      reason: r.reason,
      createdById: r.createdById,
      createdByName: fullName(people.get(r.createdById)),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** Opens this year's accounts for everyone active (the daily job). */
  async openYear(people: ShiftPerson[], now: Date): Promise<number> {
    if (!people.length) return 0;
    const policyOf = await this.policies.forPeople(people, now);
    const year = thisYearOf(now);
    const ids = people.map((p) => p.id);
    const [joins, quotas, existing] = await Promise.all([
      this.people.joinDates(ids),
      this.repo.quotasOf(ids),
      this.repo.accountsOf(ids),
    ]);
    const missing = people.flatMap((p) =>
      missingAccounts(
        {
          userId: p.id,
          joinDate: joins.get(p.id) ?? `${year}-01-01`,
          quotas: quotaMap(quotas.filter((q) => q.userId === p.id)),
        },
        existing.filter((a) => a.userId === p.id),
        year,
        LeavePolicyService.accountPolicy(policyOf(p)),
      ),
    );
    if (missing.length) await this.repo.createAccounts(missing);
    return missing.length;
  }

  private async tell(
    to: string[],
    type: string,
    title: string,
    body: string,
    fromUserId: string | null,
  ): Promise<void> {
    try {
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(to, type, title, body, fromUserId),
      );
    } catch (err) {
      this.logger.warn(`leave notice ${type} failed: ${(err as Error).message}`);
    }
  }
}
