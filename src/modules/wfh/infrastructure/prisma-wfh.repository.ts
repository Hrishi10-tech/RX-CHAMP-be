import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { assertMonthOpen } from '@shared/database/month-lock';
import { DeciderRole } from '@modules/leave/domain/routing';
import { WfhDayRecord, WfhRequestRecord, WfhScheduleRecord } from '../domain/wfh';
import {
  HeldWfhDay,
  NewWfhRequest,
  NewWfhSchedule,
  WfhRepository,
  WfhRequestFilter,
  WfhRequestPatch,
  WfhSchedulePatch,
  WfhTx,
} from '../domain/wfh.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOBODY = '00000000-0000-0000-0000-000000000000';
const uuids = (ids: string[]) => ids.filter((id) => UUID.test(id));
const ACTIVE: Prisma.EnumLeaveStatusFilter = { in: ['PENDING', 'APPROVED'] };

type RequestRow = Prisma.WfhRequestGetPayload<{ include: { days: true } }>;
type ScheduleRow = Prisma.WfhScheduleGetPayload<object>;

function toRequest(r: RequestRow): WfhRequestRecord {
  return {
    id: r.id,
    userId: r.userId,
    kind: r.kind,
    part: r.part,
    startDate: r.startDate,
    endDate: r.endDate,
    units: r.units,
    reason: r.reason,
    status: r.status,
    approverRole: r.approverRole as DeciderRole | null,
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

function toSchedule(r: ScheduleRow): WfhScheduleRecord {
  return {
    id: r.id,
    userId: r.userId,
    weekdays: [...(r.weekdays ?? [])].sort((a, b) => a - b),
    weeks: [...(r.weeks ?? [])].sort((a, b) => a - b),
    kind: r.kind,
    part: r.part,
    fromDate: r.fromDate,
    toDate: r.toDate,
    skipDates: [...(r.skipDates ?? [])].sort(),
    note: r.note,
    createdById: r.createdById,
    updatedById: r.updatedById,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function heldRow(d: {
  requestId: string;
  userId: string;
  date: string;
  mask: number;
  units: number;
  request: { status: HeldWfhDay['status'] };
}): HeldWfhDay {
  return {
    requestId: d.requestId,
    userId: d.userId,
    date: d.date,
    mask: d.mask,
    units: d.units,
    status: d.request.status,
  };
}

class PrismaWfhTx implements WfhTx {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  assertMonthOpen(dateKey: string, userId: string): Promise<void> {
    return assertMonthOpen(this.tx, dateKey, userId);
  }

  async heldDays(
    userId: string,
    from: string,
    to: string,
    exceptRequestId?: string,
  ): Promise<HeldWfhDay[]> {
    const rows = await this.tx.wfhRequestDay.findMany({
      where: {
        userId,
        date: { gte: from, lte: to },
        request: { status: ACTIVE, ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}) },
      },
      include: { request: { select: { status: true } } },
    });
    return rows.map(heldRow);
  }

  async findRequest(id: string): Promise<WfhRequestRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.tx.wfhRequest.findUnique({ where: { id }, include: { days: true } });
    return row ? toRequest(row) : null;
  }

  async insertRequest(data: NewWfhRequest, days: WfhDayRecord[]): Promise<WfhRequestRecord> {
    const row = await this.tx.wfhRequest.create({
      data: { ...data, days: { create: days.map((d) => ({ userId: data.userId, ...d })) } },
      include: { days: true },
    });
    return toRequest(row);
  }

  async updateRequest(
    id: string,
    patch: WfhRequestPatch,
    days?: WfhDayRecord[],
  ): Promise<WfhRequestRecord> {
    if (days) {
      const current = await this.tx.wfhRequest.findUniqueOrThrow({
        where: { id },
        select: { userId: true },
      });
      await this.tx.wfhRequestDay.deleteMany({ where: { requestId: id } });
      if (days.length) {
        await this.tx.wfhRequestDay.createMany({
          data: days.map((d) => ({ requestId: id, userId: current.userId, ...d })),
        });
      }
    }
    const row = await this.tx.wfhRequest.update({
      where: { id },
      data: patch,
      include: { days: true },
    });
    return toRequest(row);
  }

  async schedulesOf(userId: string): Promise<WfhScheduleRecord[]> {
    const rows = await this.tx.wfhSchedule.findMany({
      where: { userId },
      orderBy: { fromDate: 'asc' },
    });
    return rows.map(toSchedule);
  }

  async unitsInMonth(userId: string, month: string, exceptRequestId?: string): Promise<number> {
    const agg = await this.tx.wfhRequestDay.aggregate({
      where: {
        userId,
        date: { startsWith: `${month}-` },
        request: { status: ACTIVE, ...(exceptRequestId ? { id: { not: exceptRequestId } } : {}) },
      },
      _sum: { units: true },
    });
    return agg._sum.units ?? 0;
  }
}

@Injectable()
export class PrismaWfhRepository implements WfhRepository {
  constructor(private readonly prisma: PrismaService) {}

  inUserLock<T>(userId: string, fn: (tx: WfhTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const key = `rxv:wfh:${userId}`;
        await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${key}))) AS l`;
        return fn(new PrismaWfhTx(tx));
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  async findRequest(id: string): Promise<WfhRequestRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.wfhRequest.findUnique({ where: { id }, include: { days: true } });
    return row ? toRequest(row) : null;
  }

  async listRequests(f: WfhRequestFilter): Promise<WfhRequestRecord[]> {
    const where: Prisma.WfhRequestWhereInput = {};
    if (f.userId) where.userId = UUID.test(f.userId) ? f.userId : NOBODY;
    if (f.userIds) {
      const ids = uuids(f.userIds);
      where.userId = f.userId ? (ids.includes(f.userId) ? f.userId : NOBODY) : { in: ids };
    }
    if (f.statuses?.length) where.status = { in: f.statuses };
    if (f.to) where.startDate = { lte: f.to };
    if (f.from) where.endDate = { gte: f.from };
    const rows = await this.prisma.wfhRequest.findMany({
      where,
      include: { days: true },
      orderBy:
        f.order === 'SOONEST'
          ? [{ startDate: 'asc' }, { createdAt: 'asc' }]
          : f.order === 'DECIDED'
            ? [{ decidedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }]
            : [{ createdAt: 'desc' }],
      take: Math.min(1000, Math.max(1, f.limit ?? 200)),
    });
    return rows.map(toRequest);
  }

  async lockedMonths(companyIds: string[], months: string[]): Promise<Set<string>> {
    const wantedMonths = [...new Set(months)];
    const wantedOrgs = uuids([...new Set(companyIds.filter(Boolean))]);
    if (!wantedMonths.length || !wantedOrgs.length) return new Set();
    // 4.0: a month is locked per organisation.
    const rows = await this.prisma.monthLock.findMany({
      where: { month: { in: wantedMonths }, companyId: { in: wantedOrgs } },
      select: { month: true, companyId: true },
    });
    return new Set(rows.map((r) => `${r.companyId}|${r.month}`));
  }

  async heldDaysOf(userIds: string[], from: string, to: string): Promise<HeldWfhDay[]> {
    const ids = uuids(userIds);
    if (!ids.length || from > to) return [];
    const rows = await this.prisma.wfhRequestDay.findMany({
      where: { userId: { in: ids }, date: { gte: from, lte: to }, request: { status: ACTIVE } },
      include: { request: { select: { status: true } } },
    });
    return rows.map(heldRow);
  }

  async pendingInMonth(month: string, userIds?: string[]): Promise<number> {
    return this.prisma.wfhRequest.count({
      where: {
        status: 'PENDING',
        ...(userIds ? { userId: { in: uuids(userIds) } } : {}),
        days: { some: { date: { startsWith: `${month}-` } } },
      },
    });
  }

  async findSchedule(id: string): Promise<WfhScheduleRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.wfhSchedule.findUnique({ where: { id } });
    return row ? toSchedule(row) : null;
  }

  async schedulesBetween(
    userIds: string[] | undefined,
    from: string,
    to: string,
  ): Promise<WfhScheduleRecord[]> {
    if (userIds && !uuids(userIds).length) return [];
    const rows = await this.prisma.wfhSchedule.findMany({
      where: {
        ...(userIds ? { userId: { in: uuids(userIds) } } : {}),
        fromDate: { lte: to },
        OR: [{ toDate: null }, { toDate: { gte: from } }],
      },
      orderBy: [{ fromDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(toSchedule);
  }

  async insertSchedule(data: NewWfhSchedule): Promise<WfhScheduleRecord> {
    return toSchedule(await this.prisma.wfhSchedule.create({ data }));
  }

  async updateSchedule(id: string, patch: WfhSchedulePatch): Promise<WfhScheduleRecord> {
    return toSchedule(await this.prisma.wfhSchedule.update({ where: { id }, data: patch }));
  }

  async deleteSchedule(id: string): Promise<boolean> {
    const res = await this.prisma.wfhSchedule.deleteMany({ where: { id } });
    return res.count > 0;
  }
}
