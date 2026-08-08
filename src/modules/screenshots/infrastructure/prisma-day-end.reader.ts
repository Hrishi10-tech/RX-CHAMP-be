import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { DayEndReader } from '../domain/day-end.reader';

@Injectable()
export class PrismaDayEndReader implements DayEndReader {
  constructor(private readonly prisma: PrismaService) {}

  async hasEnded(userId: string, date: string): Promise<boolean> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
      select: { userId: true },
    });
    return row !== null;
  }
}
