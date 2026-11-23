import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { DayPunch, PunchesReader } from '../domain/punches.reader';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PrismaPunchesReader implements PunchesReader {
  constructor(private readonly prisma: PrismaService) {}

  async punchesOf(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<Map<string, DayPunch[]>> {
    const out = new Map<string, DayPunch[]>();
    const ids = [...new Set(userIds)].filter((id) => UUID.test(id));
    if (!ids.length || fromDate > toDate) return out;
    const rows = await this.prisma.biometricPunch.findMany({
      where: { userId: { in: ids }, dayKey: { gte: fromDate, lte: toDate } },
      orderBy: [{ punchedAt: 'asc' }],
      take: 20_000,
    });
    for (const r of rows) {
      const key = `${r.userId}|${r.dayKey}`;
      const list = out.get(key) ?? [];
      list.push({
        id: r.id,
        at: r.punchedAt,
        direction: r.direction === 'IN' || r.direction === 'OUT' ? r.direction : null,
        deviceId: r.deviceId,
        source: r.source,
        note: r.note,
        voided: r.voidedAt !== null,
      });
      out.set(key, list);
    }
    return out;
  }
}
