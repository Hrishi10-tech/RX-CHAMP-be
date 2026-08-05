import { Injectable } from '@nestjs/common';
import { Prisma, Screenshot as PrismaScreenshot } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  CreateScreenshotData,
  ListScreenshotsFilter,
  ScreenshotRecord,
  ScreenshotRepository,
} from '../domain/screenshot.repository';

@Injectable()
export class PrismaScreenshotRepository implements ScreenshotRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateScreenshotData): Promise<ScreenshotRecord> {
    const row = await this.prisma.screenshot.create({
      data: {
        userId: data.userId,
        storageKey: data.storageKey,
        kind: data.kind,
        takenAt: data.takenAt,
        ocrText: data.ocrText ?? null,
      },
    });
    return this.toRecord(row);
  }

  async listForUser(userId: string, filter: ListScreenshotsFilter): Promise<ScreenshotRecord[]> {
    const rows = await this.prisma.screenshot.findMany({
      where: this.where(userId, filter),
      orderBy: { takenAt: 'desc' },
      skip: filter.offset && filter.offset > 0 ? filter.offset : undefined,
      take: filter.limit,
    });
    return rows.map((r) => this.toRecord(r));
  }

  async countForUser(userId: string, filter: ListScreenshotsFilter): Promise<number> {
    return this.prisma.screenshot.count({ where: this.where(userId, filter) });
  }

  async archive(userId: string, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.prisma.screenshot.updateMany({
      where: { userId, id: { in: ids }, archivedAt: null },
      data: { archivedAt: new Date() },
    });
    return res.count;
  }

  private where(userId: string, filter: ListScreenshotsFilter): Prisma.ScreenshotWhereInput {
    const where: Prisma.ScreenshotWhereInput = { userId };
    if (filter.from || filter.to) {
      where.takenAt = {};
      // Half-open window [from, to): `to` is exclusive so a shot at exactly the
      // next-day boundary belongs to the next day only (no double-counting).
      if (filter.from) where.takenAt.gte = filter.from;
      if (filter.to) where.takenAt.lt = filter.to;
    }
    if (filter.kind) where.kind = filter.kind;
    if (!filter.includeArchived) where.archivedAt = null;
    if (filter.q && filter.q.trim()) {
      where.ocrText = { contains: filter.q.trim(), mode: 'insensitive' };
    }
    return where;
  }

  private toRecord(row: PrismaScreenshot): ScreenshotRecord {
    return {
      id: row.id,
      userId: row.userId,
      storageKey: row.storageKey,
      kind: row.kind,
      takenAt: row.takenAt,
      createdAt: row.createdAt,
    };
  }
}
