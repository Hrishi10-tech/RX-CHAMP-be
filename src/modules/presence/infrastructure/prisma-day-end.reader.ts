import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { DayEnd, DayEndReader } from '../domain/day-end.reader';

@Injectable()
export class PrismaDayEndReader implements DayEndReader {
  constructor(private readonly prisma: PrismaService) {}

  async findEnd(userId: string, date: string): Promise<DayEnd | null> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
      select: { userId: true, endedAt: true },
    });
    return row ?? null;
  }

  async findEndsForUsers(userIds: string[], date: string): Promise<Map<string, DayEnd>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.workDayEnd.findMany({
      where: { userId: { in: userIds }, date },
      select: { userId: true, endedAt: true },
    });
    return new Map(rows.map((r) => [r.userId, r]));
  }
}
