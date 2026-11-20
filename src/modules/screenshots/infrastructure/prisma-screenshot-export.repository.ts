import { Injectable } from '@nestjs/common';
import { Prisma, ScreenshotExport } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  ExportRecord,
  MonthShotCount,
  NewExport,
  ScreenshotExportRepository,
  ShotOwner,
  ShotRow,
} from '../domain/screenshot-export.repository';
import { ExportKind } from '../domain/screenshot-export';

function fromRow(r: ScreenshotExport): ExportRecord {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    requestedById: r.requestedById,
    companyId: r.companyId,
    userId: r.userId,
    month: r.month,
    fromDate: r.fromDate,
    toDate: r.toDate,
    fromTime: r.fromTime,
    toTime: r.toTime,
    archiveId: r.archiveId,
    total: r.total,
    done: r.done,
    missing: r.missing,
    bytes: Number(r.bytes),
    storageKey: r.storageKey,
    fileName: r.fileName,
    error: r.error,
    complete: r.complete,
    coveredUntil: r.coveredUntil,
    cancelRequested: r.cancelRequested,
    lastSeenAt: r.lastSeenAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    downloadedAt: r.downloadedAt,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  };
}

function shotWhere(filter: {
  userId?: string;
  companyId?: string;
  from: Date;
  to: Date;
  createdBefore?: Date;
}): Prisma.ScreenshotWhereInput {
  return {
    ...(filter.userId ? { userId: filter.userId } : { userId: { not: null } }),
    takenAt: { gte: filter.from, lt: filter.to },
    ...(filter.createdBefore ? { createdAt: { lt: filter.createdBefore } } : {}),
    // 4.0: only the organisation's people.
    ...(filter.companyId ? { user: { companyId: filter.companyId } } : {}),
  };
}

@Injectable()
export class PrismaScreenshotExportRepository implements ScreenshotExportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: NewExport): Promise<ExportRecord> {
    const row = await this.prisma.screenshotExport.create({
      data: {
        kind: data.kind,
        requestedById: data.requestedById,
        companyId: data.companyId ?? null,
        userId: data.userId ?? null,
        month: data.month ?? null,
        fromDate: data.fromDate ?? null,
        toDate: data.toDate ?? null,
        fromTime: data.fromTime ?? null,
        toTime: data.toTime ?? null,
        archiveId: data.archiveId ?? null,
        total: data.total,
      },
    });
    return fromRow(row);
  }

  async find(id: string): Promise<ExportRecord | null> {
    const row = await this.prisma.screenshotExport.findUnique({ where: { id } });
    return row ? fromRow(row) : null;
  }

  async claimNext(now: Date): Promise<ExportRecord | null> {
    const next = await this.prisma.screenshotExport.findFirst({
      where: { status: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
    if (!next) return null;
    const res = await this.prisma.screenshotExport.updateMany({
      where: { id: next.id, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: now },
    });
    if (!res.count) return null;
    return this.find(next.id);
  }

  async failInterrupted(message: string, now: Date): Promise<number> {
    const res = await this.prisma.screenshotExport.updateMany({
      where: { status: 'RUNNING' },
      data: { status: 'FAILED', error: message, finishedAt: now },
    });
    return res.count;
  }

  async update(
    id: string,
    data: Partial<Omit<ExportRecord, 'id' | 'kind' | 'createdAt'>>,
  ): Promise<void> {
    const { bytes, ...rest } = data;
    await this.prisma.screenshotExport.update({
      where: { id },
      data: { ...rest, ...(bytes !== undefined ? { bytes: BigInt(Math.round(bytes)) } : {}) },
    });
  }

  async touch(id: string, now: Date): Promise<void> {
    await this.prisma.screenshotExport.updateMany({
      where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { lastSeenAt: now },
    });
  }

  async requestCancel(id: string): Promise<void> {
    await this.prisma.screenshotExport.updateMany({
      where: { id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { cancelRequested: true },
    });
    // A job nobody picked up yet just stops.
    await this.prisma.screenshotExport.updateMany({
      where: { id, status: 'QUEUED' },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }

  async listForMonth(kind: ExportKind, month: string, companyId: string): Promise<ExportRecord[]> {
    const rows = await this.prisma.screenshotExport.findMany({
      where: { kind, month, companyId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(fromRow);
  }

  async findActive(filter: {
    kind?: ExportKind;
    month?: string;
    userId?: string;
    requestedById?: string;
    companyId?: string;
  }): Promise<ExportRecord | null> {
    const row = await this.prisma.screenshotExport.findFirst({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        ...(filter.kind ? { kind: filter.kind } : {}),
        ...(filter.month ? { month: filter.month } : {}),
        ...(filter.userId ? { userId: filter.userId } : {}),
        ...(filter.requestedById ? { requestedById: filter.requestedById } : {}),
        ...(filter.companyId ? { companyId: filter.companyId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return row ? fromRow(row) : null;
  }

  async listExpired(now: Date): Promise<ExportRecord[]> {
    const rows = await this.prisma.screenshotExport.findMany({
      where: { expiresAt: { lt: now }, storageKey: { not: null } },
      take: 200,
    });
    return rows.map(fromRow);
  }

  async listRecent(
    requestedById: string | null,
    limit: number,
    companyId?: string,
  ): Promise<ExportRecord[]> {
    const rows = await this.prisma.screenshotExport.findMany({
      where: {
        ...(requestedById ? { requestedById } : {}),
        ...(companyId ? { companyId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map(fromRow);
  }

  async countShots(filter: {
    userId?: string;
    companyId?: string;
    from: Date;
    to: Date;
    createdBefore?: Date;
  }) {
    return this.prisma.screenshot.count({ where: shotWhere(filter) });
  }

  async listShots(
    filter: { userId?: string; companyId?: string; from: Date; to: Date; createdBefore?: Date },
    page: { after: { takenAt: Date; id: string } | null; take: number },
  ): Promise<ShotRow[]> {
    const where = shotWhere(filter);
    const rows = await this.prisma.screenshot.findMany({
      where: page.after
        ? {
            AND: [
              where,
              {
                OR: [
                  { takenAt: { gt: page.after.takenAt } },
                  { takenAt: page.after.takenAt, id: { gt: page.after.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ takenAt: 'asc' }, { id: 'asc' }],
      take: page.take,
      select: {
        id: true,
        userId: true,
        storageKey: true,
        kind: true,
        takenAt: true,
        createdAt: true,
      },
    });
    return rows.map((r) => ({ ...r, userId: r.userId as string }));
  }

  async summarizeDays(
    filter: { userId: string; from: Date; to: Date; createdBefore?: Date },
    tz: string,
  ): Promise<{ date: string; count: number; first: Date; last: Date }[]> {
    const before = filter.createdBefore ?? new Date('9999-12-31T00:00:00Z');
    const rows = await this.prisma.$queryRaw<
      { date: string; count: bigint; first: Date; last: Date }[]
    >`
      SELECT to_char((taken_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS date,
             count(*) AS count, min(taken_at) AS first, max(taken_at) AS last
        FROM screenshots
       WHERE user_id = ${filter.userId}::uuid
         AND taken_at >= (${filter.from.toISOString()}::timestamptz AT TIME ZONE 'UTC')
         AND taken_at <  (${filter.to.toISOString()}::timestamptz AT TIME ZONE 'UTC')
         AND created_at < (${before.toISOString()}::timestamptz AT TIME ZONE 'UTC')
       GROUP BY 1
       ORDER BY 1`;
    return rows.map((r) => ({
      date: r.date,
      count: Number(r.count),
      first: r.first,
      last: r.last,
    }));
  }

  async owners(userIds: string[]): Promise<ShotOwner[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, firstName: true, lastName: true, email: true, department: true },
    });
    return rows.map((r) => ({
      id: r.id,
      name: `${r.firstName} ${r.lastName}`.trim(),
      email: r.email,
      department: r.department,
    }));
  }

  async ownersIn(from: Date, to: Date, companyId?: string): Promise<string[]> {
    const rows = await this.prisma.screenshot.findMany({
      where: {
        takenAt: { gte: from, lt: to },
        userId: { not: null },
        ...(companyId ? { user: { companyId } } : {}),
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId as string);
  }

  async countByMonth(tz: string, since: Date, companyId?: string): Promise<MonthShotCount[]> {
    const org = companyId
      ? Prisma.sql` AND EXISTS (SELECT 1 FROM users u WHERE u.id = screenshots.user_id AND u.company_id = ${companyId}::uuid)`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ month: string; count: bigint }[]>`
      SELECT to_char((taken_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM') AS month,
             count(*) AS count
        FROM screenshots
       WHERE taken_at >= (${since.toISOString()}::timestamptz AT TIME ZONE 'UTC')
         AND user_id IS NOT NULL${org}
       GROUP BY 1
       ORDER BY 1 DESC`;
    return rows.map((r) => ({ month: r.month, count: Number(r.count) }));
  }

  async deleteShots(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const res = await this.prisma.screenshot.deleteMany({ where: { id: { in: ids } } });
    return res.count;
  }
}
