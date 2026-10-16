import { Injectable } from '@nestjs/common';
import { Prisma, WorkSession } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { DayKeyFn } from '@modules/shifts/application/shift-day.resolver';
import { AgentGeneration } from '../domain/agent-generation';
import {
  AutoCloseTxResult,
  EndDayTxResult,
  EnsureOpenResult,
  LastInputQuery,
  StartDayTxResult,
  WorkSessionEndReason,
  WorkSessionRecord,
  WorkSessionRepository,
  WorkSessionSource,
} from '../domain/work-session.repository';

type Tx = Prisma.TransactionClient;

export function sessionFromPrisma(r: WorkSession): WorkSessionRecord {
  return {
    id: r.id,
    userId: r.userId,
    date: r.date,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    endReason: (r.endReason as WorkSessionEndReason | null) ?? null,
    source: r.source,
  };
}

/** Serialises every working-day change of one person (shared with the break flow). */
export async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
}

function elapsedSec(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

/** Closes every open break, lunch or meeting of the person at `at` (never before it started). */
export async function closeOpenPresence(tx: Tx, userId: string, at: Date): Promise<number> {
  const open = await tx.presenceSession.findMany({ where: { userId, endedAt: null } });
  for (const s of open) {
    const end = at.getTime() < s.startedAt.getTime() ? s.startedAt : at;
    await tx.presenceSession.update({
      where: { id: s.id },
      data: { endedAt: end, durationSec: elapsedSec(s.startedAt, end) },
    });
  }
  return open.length;
}

/** Sets the day's End Day mark when unset. True when this call set it. */
export async function markDayEnded(
  tx: Tx,
  userId: string,
  date: string,
  at: Date,
): Promise<boolean> {
  await tx.workDayEnd.createMany({ data: [{ userId, date }], skipDuplicates: true });
  const res = await tx.workDayEnd.updateMany({
    where: { userId, date, endedAt: null },
    data: { endedAt: at },
  });
  return res.count > 0;
}

/**
 * The day must be open for an action. Runs inside the caller's transaction,
 * after the user's row lock (see WorkSessionRepository.ensureOpen).
 */
export async function ensureOpenTx(
  tx: Tx,
  userId: string,
  generation: AgentGeneration,
  now: Date,
  today: string,
): Promise<EnsureOpenResult> {
  const open = await tx.workSession.findFirst({ where: { userId, endedAt: null } });
  if (open) return { ok: true, session: sessionFromPrisma(open), implicit: false };

  if (generation === 'LEGACY') {
    const end = await tx.workDayEnd.findUnique({
      where: { userId_date: { userId, date: today } },
      select: { endedAt: true },
    });
    if (end?.endedAt) return { ok: false, code: 'DAY_ENDED' };
    const created = await createSessionTx(tx, userId, now, now, 'LEGACY', () => today);
    return { ok: true, session: created, implicit: true };
  }
  const todaySessions = await tx.workSession.count({ where: { userId, date: today } });
  return { ok: false, code: todaySessions > 0 ? 'DAY_ENDED' : 'DAY_NOT_STARTED' };
}

/**
 * Opens a session at `startedAt`, never before the end of the person's last one,
 * dated by the person's working day at that moment (`dayOf`: their shift-day).
 */
async function createSessionTx(
  tx: Tx,
  userId: string,
  startedAt: Date,
  now: Date,
  source: WorkSessionSource,
  dayOf: DayKeyFn,
): Promise<WorkSessionRecord> {
  const last = await tx.workSession.findFirst({
    where: { userId, endedAt: { not: null } },
    orderBy: { endedAt: 'desc' },
    select: { endedAt: true },
  });
  let start = startedAt.getTime();
  if (last?.endedAt && last.endedAt.getTime() > start) start = last.endedAt.getTime();
  if (start > now.getTime()) start = now.getTime();
  const at = new Date(start);
  const row = await tx.workSession.create({
    data: { userId, date: dayOf(at), startedAt: at, source },
  });
  return sessionFromPrisma(row);
}

@Injectable()
export class PrismaWorkSessionRepository implements WorkSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOpen(userId: string): Promise<WorkSessionRecord | null> {
    const row = await this.prisma.workSession.findFirst({ where: { userId, endedAt: null } });
    return row ? sessionFromPrisma(row) : null;
  }

  async findLastEnded(userId: string): Promise<WorkSessionRecord | null> {
    const row = await this.prisma.workSession.findFirst({
      where: { userId, endedAt: { not: null } },
      orderBy: { endedAt: 'desc' },
    });
    return row ? sessionFromPrisma(row) : null;
  }

  async listOpen(): Promise<WorkSessionRecord[]> {
    const rows = await this.prisma.workSession.findMany({
      where: { endedAt: null },
      orderBy: { startedAt: 'asc' },
    });
    return rows.map(sessionFromPrisma);
  }

  async listForUserOnDate(userId: string, date: string): Promise<WorkSessionRecord[]> {
    const rows = await this.prisma.workSession.findMany({
      where: { userId, date },
      orderBy: { startedAt: 'asc' },
    });
    return rows.map(sessionFromPrisma);
  }

  async listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<WorkSessionRecord[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.workSession.findMany({
      where: { userId: { in: userIds }, date: { gte: fromDate, lte: toDate } },
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
    });
    return rows.map(sessionFromPrisma);
  }

  async listOverlapping(userIds: string[], from: Date, to: Date): Promise<WorkSessionRecord[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.workSession.findMany({
      where: {
        userId: { in: userIds },
        startedAt: { lte: to },
        OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      },
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
    });
    return rows.map(sessionFromPrisma);
  }

  async listUserIdsActiveOn(dates: string[]): Promise<string[]> {
    const rows = await this.prisma.workSession.findMany({
      where: { OR: [{ date: { in: dates } }, { endedAt: null }] },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  async dayEndedAt(userId: string, date: string): Promise<Date | null> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
      select: { endedAt: true },
    });
    return row?.endedAt ?? null;
  }

  async startDay(
    userId: string,
    startedAt: Date,
    now: Date,
    source: WorkSessionSource,
    dayOf: DayKeyFn,
  ): Promise<StartDayTxResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const open = await tx.workSession.findFirst({ where: { userId, endedAt: null } });
      if (open) return { opened: false, resumed: false, session: sessionFromPrisma(open) };

      const session = await createSessionTx(tx, userId, startedAt, now, source, dayOf);
      const earlier = await tx.workSession.count({
        where: { userId, date: session.date, id: { not: session.id } },
      });
      // Reopens the day for every 3.0 reader (presence, activity, screenshots).
      const days = new Set([session.date, dateKeyInZone(now, appTimezone())]);
      await tx.workDayEnd.updateMany({
        where: { userId, date: { in: [...days] }, endedAt: { not: null } },
        data: { endedAt: null },
      });
      return { opened: true, resumed: earlier > 0, session };
    });
  }

  async endDay(
    userId: string,
    now: Date,
    today: string,
    legacy: boolean,
    endedSince: Date,
  ): Promise<EndDayTxResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const open = await tx.workSession.findFirst({ where: { userId, endedAt: null } });
      // 3.0 readers (presence, the older agents) judge the calendar day.
      const calendar = dateKeyInZone(now, appTimezone());
      if (open) {
        const closed = await tx.workSession.update({
          where: { id: open.id },
          data: { endedAt: now, endReason: 'USER' },
        });
        await closeOpenPresence(tx, userId, now);
        const newlyEnded = await markDayEnded(tx, userId, open.date, now);
        // A session that ran past midnight, or a night shift's early hours.
        for (const day of new Set([today, calendar])) {
          if (day !== open.date) await markDayEnded(tx, userId, day, now);
        }
        return {
          kind: 'CLOSED' as const,
          session: sessionFromPrisma(closed),
          date: open.date,
          endedAt: now,
          newlyEnded,
        };
      }

      const end = await tx.workDayEnd.findUnique({
        where: { userId_date: { userId, date: today } },
        select: { endedAt: true },
      });
      if (end?.endedAt)
        return { kind: 'ALREADY_ENDED' as const, date: today, endedAt: end.endedAt };

      const lastToday = await tx.workSession.findFirst({
        where: { userId, date: today, endedAt: { not: null } },
        orderBy: { endedAt: 'desc' },
      });
      if (lastToday?.endedAt) {
        await markDayEnded(tx, userId, today, lastToday.endedAt);
        return { kind: 'ALREADY_ENDED' as const, date: today, endedAt: lastToday.endedAt };
      }
      if (legacy) {
        await closeOpenPresence(tx, userId, now);
        const newlyEnded = await markDayEnded(tx, userId, today, now);
        if (calendar !== today) await markDayEnded(tx, userId, calendar, now);
        return { kind: 'MARKED' as const, date: today, endedAt: now, newlyEnded };
      }
      // Pressed again after midnight, or after a night shift: the day it ended.
      const recent = await tx.workSession.findFirst({
        where: { userId, endedAt: { gte: endedSince } },
        orderBy: { endedAt: 'desc' },
      });
      if (recent?.endedAt) {
        return { kind: 'ALREADY_ENDED' as const, date: recent.date, endedAt: recent.endedAt };
      }
      return { kind: 'NOT_STARTED' as const, date: today };
    });
  }

  async ensureOpen(
    userId: string,
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<EnsureOpenResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      return ensureOpenTx(tx, userId, generation, now, today);
    });
  }

  async openImplicit(userId: string, at: Date, today: string): Promise<WorkSessionRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const open = await tx.workSession.findFirst({ where: { userId, endedAt: null } });
      if (open) return null;
      const end = await tx.workDayEnd.findUnique({
        where: { userId_date: { userId, date: today } },
        select: { endedAt: true },
      });
      if (end?.endedAt) return null;
      return createSessionTx(tx, userId, at, new Date(), 'LEGACY', () => today);
    });
  }

  async loginTimes(userId: string, dates: string[]): Promise<Date[]> {
    if (!dates.length) return [];
    const rows = await this.prisma.workDayEnd.findMany({
      where: { userId, date: { in: [...new Set(dates)] }, loginAt: { not: null } },
      select: { loginAt: true },
    });
    return rows.map((r) => r.loginAt).filter((d): d is Date => d !== null);
  }

  async autoClose(session: WorkSessionRecord, closeAt: Date): Promise<AutoCloseTxResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, session.userId);
      const res = await tx.workSession.updateMany({
        where: { id: session.id, endedAt: null },
        data: { endedAt: closeAt, endReason: 'AUTO_CLOSED' },
      });
      if (res.count === 0) return { closed: false, newlyEnded: false, droppedSkips: 0 };
      await closeOpenPresence(tx, session.userId, closeAt);
      // Auto-skips owed only because the session was still open (scheduled after
      // the real end) were never owed: they go, whatever their status or comment.
      const dropped = await tx.breakRecord.deleteMany({
        where: {
          userId: session.userId,
          date: session.date,
          outcome: 'AUTO_SKIPPED',
          scheduledStart: { gt: closeAt },
        },
      });
      const newlyEnded = await markDayEnded(tx, session.userId, session.date, closeAt);
      return { closed: true, newlyEnded, droppedSkips: dropped.count };
    });
  }

  async lastInputs(queries: LastInputQuery[]): Promise<Map<string, Date | null>> {
    const out = new Map<string, Date | null>();
    if (!queries.length) return out;
    // Timestamps are timestamp(3) holding UTC, so ISO strings are read back in UTC.
    const rows = await this.prisma.$queryRaw<{ session_id: string; last: Date | null }[]>`
      SELECT q.session_id::text AS session_id,
             (SELECT max(s.at) FROM activity_samples s
               WHERE s.user_id = q.user_id
                 AND s.idle = false
                 AND s.at >= (q.from_at::timestamptz AT TIME ZONE 'UTC')
                 AND s.at <= (q.to_at::timestamptz AT TIME ZONE 'UTC')) AS last
      FROM unnest(
        ${queries.map((q) => q.sessionId)}::uuid[],
        ${queries.map((q) => q.userId)}::uuid[],
        ${queries.map((q) => q.from.toISOString())}::text[],
        ${queries.map((q) => q.to.toISOString())}::text[]
      ) AS q(session_id, user_id, from_at, to_at)`;
    for (const r of rows) out.set(r.session_id, r.last);
    return out;
  }
}
