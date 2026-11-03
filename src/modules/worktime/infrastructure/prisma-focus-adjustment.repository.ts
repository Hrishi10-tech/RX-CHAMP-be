import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { assertMonthOpen } from '@shared/database/month-lock';
import { FocusAdjustmentRecord } from '../domain/focus-adjustment';
import {
  AdjustmentListFilter,
  AdjustmentPersonName,
  FocusAdjustmentRepository,
  NewFocusAdjustment,
} from '../domain/focus-adjustment.repository';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Prisma.FocusAdjustmentGetPayload<object>;

function fromPrisma(r: Row): FocusAdjustmentRecord {
  return {
    id: r.id,
    userId: r.userId,
    date: r.date,
    deltaSec: r.deltaSec,
    reason: r.reason,
    createdById: r.createdById,
    createdAt: r.createdAt,
    voidedAt: r.voidedAt,
    voidedById: r.voidedById,
  };
}

/** Manual focus adjustments (3.3) in table focus_adjustments; month locks per organisation (4.0). */
@Injectable()
export class PrismaFocusAdjustmentRepository implements FocusAdjustmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<FocusAdjustmentRecord[]> {
    const ids = userIds.filter((id) => UUID.test(id));
    if (!ids.length) return [];
    const rows = await this.prisma.focusAdjustment.findMany({
      where: { userId: { in: ids }, date: { gte: fromDate, lte: toDate } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(fromPrisma);
  }

  async list(filter: AdjustmentListFilter): Promise<FocusAdjustmentRecord[]> {
    const where: Prisma.FocusAdjustmentWhereInput = {};
    const and: Prisma.FocusAdjustmentWhereInput[] = [];
    if (filter.userId) and.push({ userId: UUID.test(filter.userId) ? filter.userId : '' });
    if (filter.userIds) and.push({ userId: { in: filter.userIds.filter((id) => UUID.test(id)) } });
    if (filter.companyId) {
      const people = await this.prisma.user.findMany({
        where: { companyId: UUID.test(filter.companyId) ? filter.companyId : '' },
        select: { id: true },
      });
      and.push({ userId: { in: people.map((p) => p.id) } });
    }
    if (and.length) where.AND = and;
    if (filter.month) where.date = { startsWith: `${filter.month}-` };
    if (!filter.includeVoided) where.voidedAt = null;
    const rows = await this.prisma.focusAdjustment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: Math.min(500, Math.max(1, filter.limit ?? 100)),
    });
    return rows.map(fromPrisma);
  }

  async findById(id: string): Promise<FocusAdjustmentRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.focusAdjustment.findUnique({ where: { id } });
    return row ? fromPrisma(row) : null;
  }

  async create(data: NewFocusAdjustment, now: Date): Promise<FocusAdjustmentRecord> {
    return this.prisma.$transaction(async (tx) => {
      await assertMonthOpen(tx, data.date, data.userId);
      const row = await tx.focusAdjustment.create({ data: { ...data, createdAt: now } });
      return fromPrisma(row);
    });
  }

  async void(id: string, byId: string, now: Date): Promise<FocusAdjustmentRecord | null> {
    if (!UUID.test(id)) return null;
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.focusAdjustment.findUnique({ where: { id } });
      if (!current || current.voidedAt) return null;
      await assertMonthOpen(tx, current.date, current.userId);
      const row = await tx.focusAdjustment.update({
        where: { id },
        data: { voidedAt: now, voidedById: byId },
      });
      return fromPrisma(row);
    });
  }

  async namesOf(ids: string[]): Promise<AdjustmentPersonName[]> {
    const wanted = [...new Set(ids.filter((id) => UUID.test(id)))];
    if (!wanted.length) return [];
    const rows = await this.prisma.user.findMany({
      where: { id: { in: wanted } },
      select: { id: true, firstName: true, lastName: true, company: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      companyName: r.company?.name ?? null,
    }));
  }
}
