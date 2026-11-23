import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { assertMonthOpen, isMonthLocked } from '@shared/database/month-lock';
import {
  AccountUpdate,
  AdjustmentMode,
  CreditFilter,
  GrantSource,
  HeldLeaveDay,
  LeaveAccountRecord,
  LeaveAdjustmentRecord,
  LeaveDayRecord,
  LeaveQuotaRecord,
  LeaveRepository,
  LeaveRequestRecord,
  LeaveSums,
  LeaveTx,
  NewLeaveAccount,
  NewLeaveAdjustment,
  NewLeaveRequest,
  RequestFilter,
  RequestPatch,
} from '../domain/leave.repository';
import { DeciderRole } from '../domain/routing';
import {
  CompOffCreditPatch,
  CompOffCreditRecord,
  CompOffDayKind,
  CompOffUse,
  COMPOFF_DAY_KINDS,
  NewCompOffCredit,
} from '../domain/comp-off';
import { LeaveCategory, PoolCategory } from '../domain/leave.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: string[]) => ids.filter((id) => UUID.test(id));
const ACTIVE: Prisma.EnumLeaveStatusFilter = { in: ['PENDING', 'APPROVED'] };

type RequestRow = Prisma.LeaveRequestGetPayload<{ include: { days: true } }>;
type AccountRow = Prisma.LeaveAccountGetPayload<object>;
type AdjustmentRow = Prisma.LeaveAdjustmentGetPayload<object>;

function toRequest(r: RequestRow): LeaveRequestRecord {
  return {
    id: r.id,
    userId: r.userId,
    category: r.category,
    kind: r.kind,
    part: r.part,
    startDate: r.startDate,
    endDate: r.endDate,
    year: r.year,
    units: r.units,
    reason: r.reason,
    status: r.status,
    approverRole: (r.approverRole as DeciderRole | null) ?? null,
    approverId: r.approverId,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    days: [...r.days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({ date: d.date, mask: d.mask, units: d.units })),
  };
}

/** Accounts, quotas and adjustments exist for the two yearly pools only. */
function poolOf(c: LeaveCategory): PoolCategory {
  return c === 'ELPL' ? 'ELPL' : 'CLSL';
}

function toAccount(r: AccountRow): LeaveAccountRecord {
  return {
    id: r.id,
    userId: r.userId,
    year: r.year,
    category: poolOf(r.category),
    grantedUnits: r.grantedUnits,
    grantSource: (r.grantSource === 'PERSON' ? 'PERSON' : 'DEFAULT') as GrantSource,
    prorated: r.prorated,
    carryCapUnits: r.carryCapUnits,
    createdAt: r.createdAt,
  };
}

function toAdjustment(r: AdjustmentRow): LeaveAdjustmentRecord {
  return {
    id: r.id,
    userId: r.userId,
    year: r.year,
    category: poolOf(r.category),
    deltaUnits: r.deltaUnits,
    mode: r.mode as AdjustmentMode,
    targetUnits: r.targetUnits,
    reason: r.reason,
    createdById: r.createdById,
    createdAt: r.createdAt,
  };
}

function dayRows(requestId: string, userId: string, days: LeaveDayRecord[]) {
  return days.map((d) => ({ requestId, userId, date: d.date, mask: d.mask, units: d.units }));
}

/** Sums per (year, pool) from grouped rows. */
async function sumsFor(
  db: Prisma.TransactionClient,
  userIds: string[],
): Promise<Map<string, LeaveSums[]>> {
  const ids = uuids(userIds);
  const out = new Map<string, LeaveSums[]>();
  if (!ids.length) return out;
  const [requests, adjustments] = await Promise.all([
    db.leaveRequest.groupBy({
      by: ['userId', 'year', 'category', 'status'],
      where: { userId: { in: ids }, status: ACTIVE },
      _sum: { units: true },
    }),
    db.leaveAdjustment.groupBy({
      by: ['userId', 'year', 'category'],
      where: { userId: { in: ids } },
      _sum: { deltaUnits: true },
    }),
  ]);
  const slot = (userId: string, year: number, category: PoolCategory): LeaveSums => {
    let list = out.get(userId);
    if (!list) out.set(userId, (list = []));
    let s = list.find((x) => x.year === year && x.category === category);
    if (!s) list.push((s = { year, category, adjustedUnits: 0, takenUnits: 0, pendingUnits: 0 }));
    return s;
  };
  for (const r of requests) {
    // Comp off has no yearly pool: its requests are charged against credits (3.5).
    if (r.category === 'COMPOFF') continue;
    const s = slot(r.userId, r.year, r.category);
    if (r.status === 'APPROVED') s.takenUnits += r._sum.units ?? 0;
    else s.pendingUnits += r._sum.units ?? 0;
  }
  for (const a of adjustments) {
    if (a.category === 'COMPOFF') continue;
    slot(a.userId, a.year, a.category).adjustedUnits += a._sum.deltaUnits ?? 0;
  }
  return out;
}

function heldRow(d: {
  requestId: string;
  userId: string;
  date: string;
  mask: number;
  units: number;
  request: { category: LeaveCategory; status: HeldLeaveDay['status'] };
}): HeldLeaveDay {
  return {
    requestId: d.requestId,
    userId: d.userId,
    date: d.date,
    mask: d.mask,
    units: d.units,
    category: d.request.category,
    status: d.request.status,
  };
}

type CreditRow = Prisma.CompOffCreditGetPayload<object>;

function toCredit(r: CreditRow): CompOffCreditRecord {
  return {
    id: r.id,
    userId: r.userId,
    workedDate: r.workedDate,
    dayKind: (COMPOFF_DAY_KINDS as readonly string[]).includes(r.dayKind)
      ? (r.dayKind as CompOffDayKind)
      : 'WORKING',
    dayLabel: r.dayLabel,
    workedSec: r.workedSec,
    askedUnits: r.askedUnits,
    units: r.units,
    reason: r.reason,
    source: r.source === 'GRANT' ? 'GRANT' : 'CLAIM',
    status: r.status,
    approverRole: r.approverRole as DeciderRole | null,
    approverId: r.approverId,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    expiresOn: r.expiresOn,
    expiryNoticeAt: r.expiryNoticeAt,
    createdById: r.createdById,
    cancelledAt: r.cancelledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Charged days of active COMPOFF requests, with whose they are. */
async function usesFor(
  db: Prisma.TransactionClient,
  userIds: string[],
  exceptRequestId?: string,
): Promise<{ userId: string; use: CompOffUse }[]> {
  const ids = uuids(userIds);
  if (!ids.length) return [];
  const rows = await db.leaveRequestDay.findMany({
    where: {
      userId: { in: ids },
      request: {
        category: 'COMPOFF',
        status: ACTIVE,
        ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}),
      },
    },
    include: { request: { select: { status: true, createdAt: true } } },
  });
  return rows.map((d) => ({
    userId: d.userId,
    use: {
      requestId: d.requestId,
      date: d.date,
      units: d.units,
      status: d.request.status === 'APPROVED' ? 'APPROVED' : 'PENDING',
      order: d.request.createdAt.getTime(),
    },
  }));
}

class PrismaLeaveTx implements LeaveTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  assertMonthOpen(dateKey: string, userId: string): Promise<void> {
    return assertMonthOpen(this.tx, dateKey, userId);
  }

  isMonthLocked(dateKey: string, userId: string): Promise<boolean> {
    return isMonthLocked(this.tx, dateKey, userId);
  }

  async accounts(userId: string): Promise<LeaveAccountRecord[]> {
    const rows = await this.tx.leaveAccount.findMany({
      where: { userId },
      orderBy: { year: 'asc' },
    });
    return rows.map(toAccount);
  }

  async createAccounts(rows: NewLeaveAccount[]): Promise<void> {
    if (rows.length) await this.tx.leaveAccount.createMany({ data: rows, skipDuplicates: true });
  }

  async updateAccount(
    id: string,
    patch: Partial<
      Pick<LeaveAccountRecord, 'grantedUnits' | 'grantSource' | 'prorated' | 'carryCapUnits'>
    >,
  ): Promise<void> {
    await this.tx.leaveAccount.update({ where: { id }, data: patch });
  }

  async sums(userId: string): Promise<LeaveSums[]> {
    return (await sumsFor(this.tx, [userId])).get(userId) ?? [];
  }

  async heldDays(
    userId: string,
    from: string,
    to: string,
    exceptRequestId?: string,
  ): Promise<HeldLeaveDay[]> {
    const rows = await this.tx.leaveRequestDay.findMany({
      where: {
        userId,
        date: { gte: from, lte: to },
        request: { status: ACTIVE, ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}) },
      },
      include: { request: { select: { category: true, status: true } } },
    });
    return rows.map(heldRow);
  }

  async findRequest(id: string): Promise<LeaveRequestRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.tx.leaveRequest.findUnique({ where: { id }, include: { days: true } });
    return row ? toRequest(row) : null;
  }

  async insertRequest(data: NewLeaveRequest, days: LeaveDayRecord[]): Promise<LeaveRequestRecord> {
    const row = await this.tx.leaveRequest.create({
      data: { ...data, days: { create: days.map((d) => ({ userId: data.userId, ...d })) } },
      include: { days: true },
    });
    return toRequest(row);
  }

  async updateRequest(
    id: string,
    patch: RequestPatch,
    days?: LeaveDayRecord[],
  ): Promise<LeaveRequestRecord> {
    if (days) {
      const current = await this.tx.leaveRequest.findUniqueOrThrow({
        where: { id },
        select: { userId: true },
      });
      await this.tx.leaveRequestDay.deleteMany({ where: { requestId: id } });
      if (days.length)
        await this.tx.leaveRequestDay.createMany({ data: dayRows(id, current.userId, days) });
    }
    const row = await this.tx.leaveRequest.update({
      where: { id },
      data: patch,
      include: { days: true },
    });
    return toRequest(row);
  }

  async insertAdjustment(data: NewLeaveAdjustment): Promise<LeaveAdjustmentRecord> {
    return toAdjustment(await this.tx.leaveAdjustment.create({ data }));
  }

  async quotas(userId: string): Promise<LeaveQuotaRecord[]> {
    const rows = await this.tx.leaveQuota.findMany({
      where: { userId, category: { in: ['CLSL', 'ELPL'] } },
      select: { userId: true, category: true, unitsPerYear: true },
    });
    return rows.map((r) => ({ ...r, category: poolOf(r.category) }));
  }

  async setQuota(
    userId: string,
    category: LeaveCategory,
    units: number | null,
    byId: string,
  ): Promise<void> {
    if (units === null) {
      await this.tx.leaveQuota.deleteMany({ where: { userId, category } });
      return;
    }
    await this.tx.leaveQuota.upsert({
      where: { userId_category: { userId, category } },
      create: { userId, category, unitsPerYear: units, updatedById: byId },
      update: { unitsPerYear: units, updatedById: byId },
    });
  }

  // ---- Comp off (3.5) ---------------------------------------------------------

  async credits(userId: string): Promise<CompOffCreditRecord[]> {
    const rows = await this.tx.compOffCredit.findMany({
      where: { userId },
      orderBy: [{ workedDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toCredit);
  }

  async compOffUses(userId: string, exceptRequestId?: string): Promise<CompOffUse[]> {
    return (await usesFor(this.tx, [userId], exceptRequestId)).map((u) => u.use);
  }

  async findCredit(id: string): Promise<CompOffCreditRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.tx.compOffCredit.findUnique({ where: { id } });
    return row ? toCredit(row) : null;
  }

  async insertCredit(data: NewCompOffCredit): Promise<CompOffCreditRecord> {
    return toCredit(await this.tx.compOffCredit.create({ data }));
  }

  async updateCredit(id: string, patch: CompOffCreditPatch): Promise<CompOffCreditRecord> {
    return toCredit(await this.tx.compOffCredit.update({ where: { id }, data: patch }));
  }
}

@Injectable()
export class PrismaLeaveRepository implements LeaveRepository {
  constructor(private readonly prisma: PrismaService) {}

  inUserLock<T>(userId: string, fn: (tx: LeaveTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const key = `rxv:leave:${userId}`;
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${key}))) AS l`;
        return fn(new PrismaLeaveTx(tx));
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  async findRequest(id: string): Promise<LeaveRequestRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: { days: true },
    });
    return row ? toRequest(row) : null;
  }

  async listRequests(f: RequestFilter): Promise<LeaveRequestRecord[]> {
    const where: Prisma.LeaveRequestWhereInput = {};
    if (f.userId)
      where.userId = UUID.test(f.userId) ? f.userId : '00000000-0000-0000-0000-000000000000';
    if (f.userIds) {
      const ids = uuids(f.userIds);
      where.userId = f.userId
        ? ids.includes(f.userId)
          ? f.userId
          : '00000000-0000-0000-0000-000000000000'
        : { in: ids };
    }
    if (f.statuses?.length) where.status = { in: f.statuses };
    if (f.category) where.category = f.category;
    if (f.year) where.year = f.year;
    if (f.to) where.startDate = { lte: f.to };
    if (f.from) where.endDate = { gte: f.from };
    const rows = await this.prisma.leaveRequest.findMany({
      where,
      include: { days: true },
      orderBy:
        f.order === 'SOONEST'
          ? [{ startDate: 'asc' }, { createdAt: 'asc' }]
          : [{ createdAt: 'desc' }],
      take: Math.min(1000, Math.max(1, f.limit ?? 200)),
    });
    return rows.map(toRequest);
  }

  async accountsOf(userIds: string[], year?: number): Promise<LeaveAccountRecord[]> {
    const ids = uuids(userIds);
    if (!ids.length) return [];
    const rows = await this.prisma.leaveAccount.findMany({
      where: { userId: { in: ids }, ...(year !== undefined ? { year } : {}) },
      orderBy: { year: 'asc' },
    });
    return rows.map(toAccount);
  }

  async createAccounts(rows: NewLeaveAccount[]): Promise<void> {
    if (rows.length)
      await this.prisma.leaveAccount.createMany({ data: rows, skipDuplicates: true });
  }

  sumsOf(userIds: string[]): Promise<Map<string, LeaveSums[]>> {
    return sumsFor(this.prisma, userIds);
  }

  async adjustmentsOf(f: {
    userId?: string;
    userIds?: string[];
    year?: number;
    limit?: number;
  }): Promise<LeaveAdjustmentRecord[]> {
    const where: Prisma.LeaveAdjustmentWhereInput = {};
    if (f.userId)
      where.userId = UUID.test(f.userId) ? f.userId : '00000000-0000-0000-0000-000000000000';
    else if (f.userIds) where.userId = { in: uuids(f.userIds) };
    if (f.year !== undefined) where.year = f.year;
    const rows = await this.prisma.leaveAdjustment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(1000, Math.max(1, f.limit ?? 200)),
    });
    return rows.map(toAdjustment);
  }

  async quotasOf(userIds: string[]): Promise<LeaveQuotaRecord[]> {
    const ids = uuids(userIds);
    if (!ids.length) return [];
    const rows = await this.prisma.leaveQuota.findMany({
      where: { userId: { in: ids }, category: { in: ['CLSL', 'ELPL'] } },
      select: { userId: true, category: true, unitsPerYear: true },
    });
    return rows.map((r) => ({ ...r, category: poolOf(r.category) }));
  }

  async accountsFromYear(fromYear: number): Promise<LeaveAccountRecord[]> {
    const rows = await this.prisma.leaveAccount.findMany({ where: { year: { gte: fromYear } } });
    return rows.map(toAccount);
  }

  async updateAccounts(rows: AccountUpdate[]): Promise<void> {
    if (!rows.length) return;
    await this.prisma.$transaction(
      rows.map(({ id, ...data }) => this.prisma.leaveAccount.update({ where: { id }, data })),
    );
  }

  async heldDaysOf(userIds: string[], from: string, to: string): Promise<HeldLeaveDay[]> {
    const ids = uuids(userIds);
    if (!ids.length) return [];
    const rows = await this.prisma.leaveRequestDay.findMany({
      where: { userId: { in: ids }, date: { gte: from, lte: to }, request: { status: ACTIVE } },
      include: { request: { select: { category: true, status: true } } },
      orderBy: { date: 'asc' },
    });
    return rows.map(heldRow);
  }

  async activeRequestsFrom(fromDate: string): Promise<LeaveRequestRecord[]> {
    const rows = await this.prisma.leaveRequest.findMany({
      where: { status: ACTIVE, endDate: { gte: fromDate } },
      include: { days: true },
    });
    return rows.map(toRequest);
  }

  async joinedAt(userIds: string[]): Promise<Map<string, Date>> {
    const ids = uuids(userIds);
    if (!ids.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, createdAt: true },
    });
    return new Map(rows.map((r) => [r.id, r.createdAt] as const));
  }

  async activeRoleIds(role: 'SUPER_MANAGER' | 'SUPER_ADMIN'): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', deletedAt: null, role: { name: role } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  async pendingInMonth(month: string): Promise<number> {
    return this.prisma.leaveRequest.count({
      where: { status: 'PENDING', days: { some: { date: { startsWith: `${month}-` } } } },
    });
  }

  // ---- Comp off (3.5) ---------------------------------------------------------

  async findCredit(id: string): Promise<CompOffCreditRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.compOffCredit.findUnique({ where: { id } });
    return row ? toCredit(row) : null;
  }

  async listCredits(f: CreditFilter): Promise<CompOffCreditRecord[]> {
    const ids = f.userIds ? uuids(f.userIds) : undefined;
    if (ids && !ids.length) return [];
    const rows = await this.prisma.compOffCredit.findMany({
      where: {
        ...(f.userId ? { userId: f.userId } : {}),
        ...(ids ? { userId: { in: ids } } : {}),
        ...(f.statuses?.length ? { status: { in: f.statuses } } : {}),
        ...(f.from || f.to
          ? { workedDate: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: Math.min(1000, Math.max(1, f.limit ?? 300)),
    });
    return rows.map(toCredit);
  }

  async creditsOf(userIds: string[]): Promise<CompOffCreditRecord[]> {
    const ids = uuids(userIds);
    if (!ids.length) return [];
    const rows = await this.prisma.compOffCredit.findMany({
      where: { userId: { in: ids } },
      orderBy: [{ workedDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toCredit);
  }

  async compOffUsesOf(userIds: string[]): Promise<Map<string, CompOffUse[]>> {
    const out = new Map<string, CompOffUse[]>();
    for (const { userId, use } of await usesFor(this.prisma, userIds)) {
      const list = out.get(userId);
      if (list) list.push(use);
      else out.set(userId, [use]);
    }
    return out;
  }

  async creditsExpiring(from: string, to: string): Promise<CompOffCreditRecord[]> {
    const rows = await this.prisma.compOffCredit.findMany({
      where: { status: 'APPROVED', expiryNoticeAt: null, expiresOn: { gte: from, lte: to } },
      take: 5000,
    });
    return rows.map(toCredit);
  }

  async markExpiryNoticed(ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await this.prisma.compOffCredit.updateMany({
      where: { id: { in: ids } },
      data: { expiryNoticeAt: at },
    });
  }
}
