import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { DayEndReader } from '../domain/day-end.reader';

@Injectable()
export class PrismaDayEndReader implements DayEndReader {
  constructor(private readonly prisma: PrismaService) {}

  async hasEnded(userId: string, date: string): Promise<boolean> {
    // A day is ended only when endedAt is set — the row may exist for the login
    // time alone (endedAt null), which does not stop captures.
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
      select: { endedAt: true },
    });
    return row?.endedAt != null;
  }
}
