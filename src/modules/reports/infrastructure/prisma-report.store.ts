import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AVATAR_COLUMNS, effectiveAvatarId } from '@shared/avatars/person-avatar';
import { PrismaService } from '@shared/database/prisma.service';
import { lockMonthExclusive } from '@shared/database/month-lock';
import {
  LockMonthResult,
  MonthLockRow,
  OpenSessionBlocker,
  PendingLeaveBlocker,
  PendingWfhBlocker,
  ReportRunRow,
  ReportStore,
} from '../domain/report.store';
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
      // Leave waiting for a decision (3.4): it would change the month's attendance.
      // 4.0: the organisation's people only (requests carry the person, not the org).
      const orgPeople = (
        await tx.user.findMany({ where: { companyId }, select: { id: true } })
      ).map((u) => u.id);
      const leave = await tx.leaveRequest.count({
        where: {
          status: 'PENDING',
          userId: { in: orgPeople },
          days: { some: { date: { startsWith: `${month}-` } } },
        },
      });
      if (leave > 0) return { ok: false as const, reason: 'PENDING_LEAVE' as const, count: leave };
      // Work from home waiting (3.5): it decides what biometric staff's days at home count.
      const wfh = await tx.wfhRequest.count({
        where: {
          status: 'PENDING',
          userId: { in: orgPeople },
          days: { some: { date: { startsWith: `${month}-` } } },
        },
      });
      if (wfh > 0) return { ok: false as const, reason: 'PENDING_WFH' as const, count: wfh };
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

  async openSessionsInMonth(
    companyId: string,
    month: string,
    limit: number,
  ): Promise<OpenSessionBlocker[]> {
    const rows = await this.prisma.workSession.findMany({
      where: { endedAt: null, date: { startsWith: `${month}-` }, user: { companyId } },
      orderBy: [{ date: 'asc' }, { startedAt: 'asc' }],
      take: Math.max(1, Math.min(500, Math.floor(limit))),
      select: {
        userId: true,
        date: true,
        startedAt: true,
        user: { select: { firstName: true, lastName: true, ...AVATAR_COLUMNS } },
      },
    });
    return rows.map((r) => ({
      userId: r.userId,
      userName:
        [r.user?.firstName, r.user?.lastName].filter(Boolean).join(' ').trim() || 'Former user',
      avatarId: r.user ? effectiveAvatarId(r.user) : null,
      date: r.date,
      startedAt: r.startedAt.toISOString(),
    }));
  }

  /** Everyone of the organisation, past and present (their requests stay theirs). */
  private async orgUserIds(companyId: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({ where: { companyId }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async pendingLeaveInMonth(
    companyId: string,
    month: string,
    limit: number,
    userIds?: string[],
  ): Promise<{ count: number; items: PendingLeaveBlocker[] }> {
    const where: Prisma.LeaveRequestWhereInput = {
      status: 'PENDING',
      // 4.0: the organisation's people only.
      userId: { in: userIds ?? (await this.orgUserIds(companyId)) },
      days: { some: { date: { startsWith: `${month}-` } } },
    };
    const [count, rows] = await Promise.all([
      this.prisma.leaveRequest.count({ where }),
      this.prisma.leaveRequest.findMany({
        where,
        orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
        take: Math.max(1, Math.min(500, Math.floor(limit))),
        select: {
          id: true,
          userId: true,
          category: true,
          startDate: true,
          endDate: true,
          units: true,
        },
      }),
    ]);
    const people = rows.length
      ? await this.prisma.user.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
          select: { id: true, firstName: true, lastName: true, ...AVATAR_COLUMNS },
        })
      : [];
    const nameOf = new Map(
      people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim() || 'Former user'] as const),
    );
    const avatarOf = new Map(people.map((p) => [p.id, effectiveAvatarId(p)] as const));
    return {
      count,
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: nameOf.get(r.userId) ?? 'Former user',
        avatarId: avatarOf.get(r.userId) ?? null,
        category: r.category,
        startDate: r.startDate,
        endDate: r.endDate,
        days: r.units / 4,
      })),
    };
  }

  async pendingWfhInMonth(
    companyId: string,
    month: string,
    limit: number,
    userIds?: string[],
  ): Promise<{ count: number; items: PendingWfhBlocker[] }> {
    const where: Prisma.WfhRequestWhereInput = {
      status: 'PENDING',
      // 4.0: the organisation's people only.
      userId: { in: userIds ?? (await this.orgUserIds(companyId)) },
      days: { some: { date: { startsWith: `${month}-` } } },
    };
    const [count, rows] = await Promise.all([
      this.prisma.wfhRequest.count({ where }),
      this.prisma.wfhRequest.findMany({
        where,
        orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
        take: Math.max(1, Math.min(500, Math.floor(limit))),
        select: { id: true, userId: true, startDate: true, endDate: true, units: true },
      }),
    ]);
    const people = rows.length
      ? await this.prisma.user.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
          select: { id: true, firstName: true, lastName: true, ...AVATAR_COLUMNS },
        })
      : [];
    const nameOf = new Map(
      people.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim() || 'Former user'] as const),
    );
    const avatarOf = new Map(people.map((p) => [p.id, effectiveAvatarId(p)] as const));
    return {
      count,
      items: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userName: nameOf.get(r.userId) ?? 'Former user',
        avatarId: avatarOf.get(r.userId) ?? null,
        startDate: r.startDate,
        endDate: r.endDate,
        days: r.units / 4,
      })),
    };
  }

  async unlockMonth(companyId: string, month: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockMonthExclusive(tx, companyId, month);
      const res = await tx.monthLock.deleteMany({ where: { companyId, month } });
      return res.count > 0;
    });
  }
}
