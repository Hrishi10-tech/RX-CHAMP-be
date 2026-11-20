import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { WorkedDaysReader } from '../domain/worked-days.reader';

@Injectable()
export class PrismaWorkedDaysReader implements WorkedDaysReader {
  constructor(private readonly prisma: PrismaService) {}

  async usersWithSessionOn(userIds: string[], date: string): Promise<Set<string>> {
    const ids = [...new Set(userIds)];
    if (!ids.length) return new Set();
    const rows = await this.prisma.workSession.findMany({
      where: { userId: { in: ids }, date },
      select: { userId: true },
      distinct: ['userId'],
    });
    return new Set(rows.map((r) => r.userId));
  }
}
