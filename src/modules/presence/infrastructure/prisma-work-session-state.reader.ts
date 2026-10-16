import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '@shared/database/prisma.service';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { ShiftDayResolver } from '@modules/shifts/application/shift-day.resolver';
import { WorkSessionState, WorkSessionStateReader } from '../domain/work-session-state.reader';

/**
 * The working day comes from the shifts module's resolver (an overnight shift's
 * early hours belong to the evening before). The shifts module imports this one,
 * so the resolver is looked up at run time rather than injected.
 */
@Injectable()
export class PrismaWorkSessionStateReader implements WorkSessionStateReader {
  private resolver: ShiftDayResolver | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private dayKeys(): ShiftDayResolver | null {
    if (!this.resolver) {
      try {
        this.resolver = this.moduleRef.get(ShiftDayResolver, { strict: false });
      } catch {
        this.resolver = null;
      }
    }
    return this.resolver;
  }

  async statesFor(userIds: string[], now: Date): Promise<Map<string, WorkSessionState>> {
    const out = new Map<string, WorkSessionState>();
    const ids = [...new Set(userIds)];
    if (!ids.length) return out;
    const calendar = dateKeyInZone(now, appTimezone());
    const keys = (await this.dayKeys()?.dayKeysAt(ids, now)) ?? new Map<string, string>();
    for (const id of ids) {
      out.set(id, { open: false, startedToday: false, today: keys.get(id) ?? calendar });
    }
    const dates = [...new Set([...out.values()].map((s) => s.today))];
    const rows = await this.prisma.workSession.findMany({
      where: { userId: { in: ids }, OR: [{ endedAt: null }, { date: { in: dates } }] },
      select: { userId: true, endedAt: true, date: true },
    });
    for (const r of rows) {
      const cur = out.get(r.userId);
      if (!cur) continue;
      if (r.endedAt === null) cur.open = true;
      if (r.date === cur.today) cur.startedToday = true;
    }
    return out;
  }
}
