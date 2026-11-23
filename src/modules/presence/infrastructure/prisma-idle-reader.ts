import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { TimeInterval } from '@shared/types/common.types';
import {
  idleOutsideMeetings,
  idleSecOutsideMeetings,
  MeetingSpan,
} from '../domain/idle-outside-meetings';
import { IdleReader } from '../domain/idle-reader.port';

/**
 * Reads idle time from the activity module's `activity_samples` table. A sample
 * flagged `idle` contributes `durationSec` of idle, anchored at its `at` time, less
 * whatever falls inside a meeting: meeting time is never idle (3.6, D-22).
 */
@Injectable()
export class PrismaIdleReader implements IdleReader {
  constructor(private readonly prisma: PrismaService) {}

  async listIdleIntervalsForUserByDate(userId: string, date: string): Promise<TimeInterval[]> {
    const rows = await this.prisma.activitySample.findMany({
      where: { userId, date, idle: true },
      orderBy: { at: 'asc' },
      select: { at: true, durationSec: true },
    });
    const idle = rows.map((r) => ({
      start: r.at,
      end: new Date(r.at.getTime() + (r.durationSec ?? 0) * 1000),
    }));
    return idleOutsideMeetings(idle, await this.meetingsAround(userId, rows), new Date());
  }

  async sumIdleSecondsForUserByDates(
    userId: string,
    dates: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (dates.length === 0) return result;
    const rows = await this.prisma.activitySample.findMany({
      where: { userId, date: { in: dates }, idle: true },
      orderBy: { at: 'asc' },
      select: { date: true, at: true, durationSec: true },
    });
    const meetings = await this.meetingsAround(userId, rows);
    const now = new Date();
    for (const r of rows) {
      result.set(r.date, (result.get(r.date) ?? 0) + idleSecOutsideMeetings(r, meetings, now));
    }
    return result;
  }

  /** The person's meetings around these samples: live ones and logged ones not rejected. */
  private async meetingsAround(
    userId: string,
    samples: { at: Date; durationSec: number | null }[],
  ): Promise<MeetingSpan[]> {
    if (!samples.length) return [];
    const from = new Date(samples[0].at.getTime());
    const last = samples[samples.length - 1];
    const to = new Date(last.at.getTime() + (last.durationSec ?? 0) * 1000);
    const [presence, logged] = await Promise.all([
      this.prisma.presenceSession.findMany({
        where: {
          userId,
          type: 'MEETING',
          startedAt: { lte: to },
          OR: [{ endedAt: null }, { endedAt: { gte: from } }],
        },
        select: { startedAt: true, endedAt: true },
      }),
      this.prisma.meetingRecord.findMany({
        where: {
          userId,
          mode: 'PAST',
          approvalStatus: { not: 'REJECTED' },
          startedAt: { lte: to },
          endedAt: { gte: from },
        },
        select: { startedAt: true, endedAt: true },
      }),
    ]);
    return [...presence, ...logged].map((m) => ({ start: m.startedAt, end: m.endedAt }));
  }
}
