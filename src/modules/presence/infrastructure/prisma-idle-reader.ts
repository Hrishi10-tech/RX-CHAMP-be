import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { TimeInterval } from '@shared/types/common.types';
import { IdleReader } from '../domain/idle-reader.port';

/**
 * Reads idle time from the activity module's `activity_samples` table. A sample
 * flagged `idle` contributes `durationSec` of idle, anchored at its `at` time.
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
    return rows.map((r) => ({
      start: r.at,
      end: new Date(r.at.getTime() + (r.durationSec ?? 0) * 1000),
    }));
  }

  async sumIdleSecondsForUserByDates(
    userId: string,
    dates: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (dates.length === 0) return result;
    const rows = await this.prisma.activitySample.groupBy({
      by: ['date'],
      where: { userId, date: { in: dates }, idle: true },
      _sum: { durationSec: true },
    });
    for (const r of rows) {
      result.set(r.date, r._sum.durationSec ?? 0);
    }
    return result;
  }
}
