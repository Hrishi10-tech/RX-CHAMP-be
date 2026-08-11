import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { DayEnd, DayEndReader } from '../domain/day-end.reader';

/**
 * A day counts as ended only when `endedAt` is set. The row may also exist for the
 * login time alone (endedAt null), which must NOT be treated as ended.
 */
@Injectable()
export class PrismaDayEndReader implements DayEndReader {
  constructor(private readonly prisma: PrismaService) {}

  async findEnd(userId: string, date: string): Promise<DayEnd | null> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
      select: { userId: true, endedAt: true },
    });
    return row?.endedAt ? { userId: row.userId, endedAt: row.endedAt } : null;
  }

  async findEndsForUsers(userIds: string[], date: string): Promise<Map<string, DayEnd>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.workDayEnd.findMany({
      where: { userId: { in: userIds }, date, endedAt: { not: null } },
      select: { userId: true, endedAt: true },
    });
    return new Map(rows.map((r) => [r.userId, { userId: r.userId, endedAt: r.endedAt as Date }]));
  }
}
