import { Injectable } from '@nestjs/common';
import { ActivitySample as PrismaActivitySample } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  ActivitySampleRecord,
  ActivitySampleRepository,
  NewActivitySample,
} from '../domain/activity-sample.repository';

interface LatestRow {
  id: string;
  user_id: string;
  device_id: string | null;
  date: string;
  at: Date;
  duration_sec: number;
  idle: boolean;
  locked: boolean;
  app: string | null;
  title: string | null;
  url: string | null;
}

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

    // One indexed lookup per person (activity_samples(user_id, at)), in a single
    // round trip. Loading every sample and keeping the newest in memory pulled the
    // team's entire history on each live-board poll.
    const rows = await this.prisma.$queryRaw<LatestRow[]>`
      SELECT s.id, s.user_id, s.device_id, s.date, s.at, s.duration_sec, s.idle, s.locked,
             s.app, s.title, s.url
      FROM unnest(${userIds}::uuid[]) AS u(id)
      CROSS JOIN LATERAL (
        SELECT * FROM activity_samples a
        WHERE a.user_id = u.id
        ORDER BY a.at DESC
        LIMIT 1
      ) s`;
    for (const r of rows) {
      result.set(r.user_id, {
        id: r.id,
        userId: r.user_id,
        deviceId: r.device_id,
        date: r.date,
        at: r.at,
        durationSec: r.duration_sec,
        idle: r.idle,
        locked: r.locked,
        app: r.app,
        title: r.title,
        url: r.url,
      });
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
