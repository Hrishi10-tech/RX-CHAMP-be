import { Injectable } from '@nestjs/common';
import { ActivitySample as PrismaActivitySample } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  ActivitySampleRecord,
  ActivitySampleRepository,
  NewActivitySample,
} from '../domain/activity-sample.repository';

@Injectable()
export class PrismaActivitySampleRepository implements ActivitySampleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLatestForUser(userId: string): Promise<ActivitySampleRecord | null> {
    const row = await this.prisma.activitySample.findFirst({
      where: { userId },
      orderBy: { at: 'desc' },
    });
    return row ? this.toRecord(row) : null;
  }

  async findLatestForUsers(userIds: string[]): Promise<Map<string, ActivitySampleRecord>> {
    const result = new Map<string, ActivitySampleRecord>();
    if (userIds.length === 0) return result;

    // Newest-first, then keep the first row seen per user.
    const rows = await this.prisma.activitySample.findMany({
      where: { userId: { in: userIds } },
      orderBy: { at: 'desc' },
    });
    for (const row of rows) {
      if (!result.has(row.userId)) result.set(row.userId, this.toRecord(row));
    }
    return result;
  }

  async listForUserByDate(userId: string, date: string): Promise<ActivitySampleRecord[]> {
    const rows = await this.prisma.activitySample.findMany({
      where: { userId, date },
      orderBy: { at: 'asc' },
    });
    return rows.map((r) => this.toRecord(r));
  }

  async stampDuration(id: string, durationSec: number): Promise<void> {
    await this.prisma.activitySample.update({
      where: { id },
      data: { durationSec },
    });
  }

  async create(sample: NewActivitySample): Promise<ActivitySampleRecord> {
    const row = await this.prisma.activitySample.create({
      data: {
        userId: sample.userId,
        deviceId: sample.deviceId ?? null,
        date: sample.date,
        at: sample.at,
        idle: sample.idle,
        locked: sample.locked ?? false,
        app: sample.app ?? null,
        title: sample.title ?? null,
        url: sample.url ?? null,
      },
    });
    return this.toRecord(row);
  }

  private toRecord(r: PrismaActivitySample): ActivitySampleRecord {
    return {
      id: r.id,
      userId: r.userId,
      deviceId: r.deviceId,
      date: r.date,
      at: r.at,
      durationSec: r.durationSec,
      idle: r.idle,
      locked: r.locked,
      app: r.app,
      title: r.title,
      url: r.url,
    };
  }
}
