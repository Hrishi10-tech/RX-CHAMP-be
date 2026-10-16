import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { lockMonthExclusive } from '@shared/database/month-lock';
import { LockMonthResult, MonthLockRow, ReportRunRow, ReportStore } from '../domain/report.store';
import { MonthSnapshot } from '../domain/report.types';

/** Building a whole company's month can take a while; decisions wait meanwhile. */
const LOCK_TX = { timeout: 180_000, maxWait: 15_000 };
/** The app_settings row that records facts about this installation. */
const SYSTEM_KEY = 'system';

@Injectable()
export class PrismaReportStore implements ReportStore {
  constructor(private readonly prisma: PrismaService) {}

  async upsertRun(
    month: string,
    scope: 'TEAM' | 'ALL',
    ownerId: string,
    summary: Record<string, unknown>,
  ): Promise<void> {
    const json = summary as Prisma.InputJsonValue;
    await this.prisma.reportRun.upsert({
      where: { month_scope_ownerId: { month, scope, ownerId } },
      create: { month, scope, ownerId, summary: json },
      update: { summary: json, generatedAt: new Date() },
    });
  }

  async listRuns(ownerId: string): Promise<ReportRunRow[]> {
    const rows = await this.prisma.reportRun.findMany({
      where: { ownerId },
      orderBy: [{ month: 'desc' }, { scope: 'asc' }],
      take: 120,
    });
    return rows.map((r) => ({
      id: r.id,
      month: r.month,
      scope: r.scope === 'ALL' ? 'ALL' : 'TEAM',
      ownerId: r.ownerId,
      generatedAt: r.generatedAt,
      summary:
        r.summary && typeof r.summary === 'object' && !Array.isArray(r.summary)
          ? (r.summary as Record<string, unknown>)
          : {},
    }));
  }

  async runKeys(month: string): Promise<Set<string>> {
    const rows = await this.prisma.reportRun.findMany({
      where: { month },
      select: { scope: true, ownerId: true },
    });
    return new Set(rows.map((r) => `${r.scope}|${r.ownerId}`));
  }

  async recordFirstBoot(now: Date): Promise<Date> {
    // Set once: a second boot (or a second process) never moves it.
    await this.prisma.appSetting.createMany({
      data: [{ key: SYSTEM_KEY, value: { firstBootAt: now.toISOString() } }],
      skipDuplicates: true,
    });
    const row = await this.prisma.appSetting.findUnique({ where: { key: SYSTEM_KEY } });
    const value = row?.value as { firstBootAt?: unknown } | null | undefined;
    const at = typeof value?.firstBootAt === 'string' ? new Date(value.firstBootAt) : null;
    return at && !Number.isNaN(at.getTime()) ? at : now;
  }

  async findLock(month: string): Promise<MonthLockRow | null> {
    const row = await this.prisma.monthLock.findUnique({
      where: { month },
      select: { month: true, lockedById: true, lockedAt: true },
    });
    return row ?? null;
  }

  async findSnapshot(month: string): Promise<MonthSnapshot | null> {
    const row = await this.prisma.monthLock.findUnique({
      where: { month },
      select: { snapshot: true },
    });
    const snap = row?.snapshot as unknown as MonthSnapshot | undefined;
    return snap && snap.version === 1 ? snap : null;
  }

  async lockMonth(
    month: string,
    lockedById: string,
    buildSnapshot: () => Promise<MonthSnapshot>,
  ): Promise<LockMonthResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockMonthExclusive(tx, month);
      const existing = await tx.monthLock.findUnique({
        where: { month },
        select: { month: true, lockedById: true, lockedAt: true },
      });
      if (existing) return { ok: true as const, lock: existing, created: false };
      const open = await tx.workSession.count({
        where: { endedAt: null, date: { startsWith: `${month}-` } },
      });
      if (open > 0) return { ok: false as const, reason: 'OPEN_SESSIONS' as const, count: open };
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT (
          (SELECT count(*) FROM break_records WHERE approval_status = 'PENDING' AND left(date, 7) = ${month})
          + (SELECT count(*) FROM meeting_records WHERE approval_status = 'PENDING' AND left(date, 7) = ${month})
        )::int AS n`;
      const pending = rows[0]?.n ?? 0;
      if (pending > 0) {
        return { ok: false as const, reason: 'PENDING_APPROVALS' as const, count: pending };
      }
      const snapshot = await buildSnapshot();
      const lock = await tx.monthLock.create({
        data: { month, lockedById, snapshot: snapshot as unknown as Prisma.InputJsonValue },
        select: { month: true, lockedById: true, lockedAt: true },
      });
      return { ok: true as const, lock, created: true };
    }, LOCK_TX);
  }

  async unlockMonth(month: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockMonthExclusive(tx, month);
      const res = await tx.monthLock.deleteMany({ where: { month } });
      return res.count > 0;
    });
  }
}
