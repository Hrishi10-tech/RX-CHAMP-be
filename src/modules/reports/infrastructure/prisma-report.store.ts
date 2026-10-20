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
    companyId: string,
    month: string,
    scope: 'TEAM' | 'ALL',
    ownerId: string,
    summary: Record<string, unknown>,
  ): Promise<void> {
    const json = summary as Prisma.InputJsonValue;
    await this.prisma.reportRun.upsert({
      where: { companyId_month_scope_ownerId: { companyId, month, scope, ownerId } },
      create: { companyId, month, scope, ownerId, summary: json },
      update: { summary: json, generatedAt: new Date() },
    });
  }

  async listRuns(companyId: string, ownerId: string | null): Promise<ReportRunRow[]> {
    const rows = await this.prisma.reportRun.findMany({
      where: ownerId ? { companyId, ownerId } : { companyId, scope: 'ALL' },
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

  async runKeys(companyId: string, month: string): Promise<Set<string>> {
    const rows = await this.prisma.reportRun.findMany({
      where: { companyId, month },
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

  async findLock(companyId: string, month: string): Promise<MonthLockRow | null> {
    const row = await this.prisma.monthLock.findUnique({
      where: { companyId_month: { companyId, month } },
      select: { month: true, lockedById: true, lockedAt: true },
    });
    return row ?? null;
  }

  async findSnapshot(companyId: string, month: string): Promise<MonthSnapshot | null> {
    const row = await this.prisma.monthLock.findUnique({
      where: { companyId_month: { companyId, month } },
      select: { snapshot: true },
    });
    const snap = row?.snapshot as unknown as MonthSnapshot | undefined;
    return snap && snap.version === 1 ? snap : null;
  }

  async lockMonth(
    companyId: string,
    month: string,
    lockedById: string,
    buildSnapshot: () => Promise<MonthSnapshot>,
  ): Promise<LockMonthResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockMonthExclusive(tx, companyId, month);
      const existing = await tx.monthLock.findUnique({
        where: { companyId_month: { companyId, month } },
        select: { month: true, lockedById: true, lockedAt: true },
      });
      if (existing) return { ok: true as const, lock: existing, created: false };
      const open = await tx.workSession.count({
        where: { endedAt: null, date: { startsWith: `${month}-` }, user: { companyId } },
      });
      if (open > 0) return { ok: false as const, reason: 'OPEN_SESSIONS' as const, count: open };
      const rows = await tx.$queryRaw<{ n: number }[]>`
        SELECT (
          (SELECT count(*) FROM break_records b JOIN users u ON u.id = b.user_id
             WHERE b.approval_status = 'PENDING' AND left(b.date, 7) = ${month} AND u.company_id = ${companyId}::uuid)
          + (SELECT count(*) FROM meeting_records m JOIN users u ON u.id = m.user_id
             WHERE m.approval_status = 'PENDING' AND left(m.date, 7) = ${month} AND u.company_id = ${companyId}::uuid)
          + (SELECT count(*) FROM away_events a
             WHERE a.status = 'PENDING' AND left(a.date, 7) = ${month} AND a.company_id = ${companyId}::uuid)
        )::int AS n`;
      const pending = rows[0]?.n ?? 0;
      if (pending > 0) {
        return { ok: false as const, reason: 'PENDING_APPROVALS' as const, count: pending };
      }
      const snapshot = await buildSnapshot();
      const lock = await tx.monthLock.create({
        data: {
          companyId,
          month,
          lockedById,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
        },
        select: { month: true, lockedById: true, lockedAt: true },
      });
      return { ok: true as const, lock, created: true };
    }, LOCK_TX);
  }

  async unlockMonth(companyId: string, month: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockMonthExclusive(tx, companyId, month);
      const res = await tx.monthLock.deleteMany({ where: { companyId, month } });
      return res.count > 0;
    });
  }
}
