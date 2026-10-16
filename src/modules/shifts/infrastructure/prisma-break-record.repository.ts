import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { assertMonthOpen } from '@shared/database/month-lock';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import {
  ApprovalFilter,
  BreakRecordRepository,
  BreakRecordRow,
  Decision,
  FinishBreak,
  FinishBreakResult,
  NewBreakRecord,
  Routing,
  StartBreakOutcome,
  isReplaceableAutoSkip,
} from '../domain/break-record.repository';
import {
  ApproverRole,
  BreakApprovalStatus,
  BreakKind,
  BreakOutcome,
  BreakPresenceType,
  BreakTiming,
} from '../domain/shift.types';
import { isUuid } from './prisma-shift.repository';

const WITH_SESSION = { presenceSession: { select: { endedAt: true } } } as const;
type Row = Prisma.BreakRecordGetPayload<{ include: typeof WITH_SESSION }>;

export function breakRowFromPrisma(r: Row): BreakRecordRow {
  return {
    id: r.id,
    userId: r.userId,
    date: r.date,
    kind: (r.kind as BreakKind | null) ?? null,
    seq: r.seq,
    presenceType: r.presenceType as BreakPresenceType,
    shiftId: r.shiftId,
    shiftName: r.shiftName,
    scheduledStart: r.scheduledStart,
    durationMin: r.durationMin,
    windowOpen: r.windowOpen,
    windowClose: r.windowClose,
    ringStart: r.ringStart,
    ringEnd: r.ringEnd,
    presenceSessionId: r.presenceSessionId,
    startedAt: r.startedAt,
    // No session (a skip, or a deleted one) means nothing is running: ended at start.
    endedAt: r.presenceSession ? r.presenceSession.endedAt : r.startedAt,
    timing: r.timing as BreakTiming,
    minutesOff: r.minutesOff,
    reason: r.reason,
    overrunReason: r.overrunReason,
    source: r.source,
    approvalStatus: r.approvalStatus as BreakApprovalStatus,
    approverRole: (r.approverRole as ApproverRole | null) ?? null,
    approverId: r.approverId,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt,
    outcome: r.outcome as BreakOutcome,
    overrunSec: r.overrunSec,
    overrunAsked: r.overrunAsked,
    commentedAt: r.commentedAt,
    dueAt: r.dueAt,
    escalatedAt: r.escalatedAt,
    remindedAt: r.remindedAt,
  };
}

export const BREAK_ROW_INCLUDE = WITH_SESSION;

function elapsedSec(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

/** The columns every move to PENDING sets: a fresh 48-hour clock, no reminder or escalation yet. */
export function pendingClock(now: Date, slaHours: number) {
  return {
    dueAt: new Date(now.getTime() + slaHours * 3_600_000),
    escalatedAt: null,
    remindedAt: null,
  };
}

@Injectable()
export class PrismaBreakRecordRepository implements BreakRecordRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
  ) {}

  private async slaHours(): Promise<number> {
    return (await this.settings.get()).approvalSlaHours;
  }

  async findById(id: string): Promise<BreakRecordRow | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.breakRecord.findUnique({ where: { id }, include: WITH_SESSION });
    return row ? breakRowFromPrisma(row) : null;
  }

  async listByIds(ids: string[]): Promise<BreakRecordRow[]> {
    const wanted = [...new Set(ids)].filter(isUuid);
    if (!wanted.length) return [];
    const rows = await this.prisma.breakRecord.findMany({
      where: { id: { in: wanted } },
      include: WITH_SESSION,
    });
    return rows.map(breakRowFromPrisma);
  }

  async listForUserOnDate(userId: string, date: string): Promise<BreakRecordRow[]> {
    const rows = await this.prisma.breakRecord.findMany({
      where: { userId, date },
      include: WITH_SESSION,
      orderBy: { startedAt: 'asc' },
    });
    return rows.map(breakRowFromPrisma);
  }

  async listForUsersOnDate(userIds: string[], date: string): Promise<BreakRecordRow[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.breakRecord.findMany({
      where: { userId: { in: userIds }, date },
      include: WITH_SESSION,
      orderBy: { startedAt: 'asc' },
    });
    return rows.map(breakRowFromPrisma);
  }

  async listForUserBetween(
    userId: string,
    fromDate: string,
    toDate: string,
  ): Promise<BreakRecordRow[]> {
    const rows = await this.prisma.breakRecord.findMany({
      where: { userId, date: { gte: fromDate, lte: toDate } },
      include: WITH_SESSION,
      orderBy: [{ date: 'desc' }, { startedAt: 'desc' }],
    });
    return rows.map(breakRowFromPrisma);
  }

  async listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<BreakRecordRow[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.breakRecord.findMany({
      where: { userId: { in: userIds }, date: { gte: fromDate, lte: toDate } },
      include: WITH_SESSION,
      orderBy: [{ date: 'asc' }, { startedAt: 'asc' }],
    });
    return rows.map(breakRowFromPrisma);
  }

  async listSkipsNeedingComment(userId: string, fromDate: string): Promise<BreakRecordRow[]> {
    const rows = await this.prisma.breakRecord.findMany({
      where: {
        userId,
        date: { gte: fromDate },
        outcome: { in: ['SKIPPED', 'AUTO_SKIPPED'] },
        reason: null,
        approvalStatus: 'PENDING',
      },
      include: WITH_SESSION,
      orderBy: [{ date: 'desc' }, { startedAt: 'desc' }],
    });
    return rows.map(breakRowFromPrisma);
  }

  async startScheduled(
    record: NewBreakRecord,
    keys: { calendarDay: string },
    now: Date,
  ): Promise<StartBreakOutcome> {
    const clock =
      record.approvalStatus === 'PENDING' ? pendingClock(now, await this.slaHours()) : {};
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialise every status change for this person: two taps (or the agent
        // retrying) can never open two breaks or double-book one.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${record.userId}::uuid FOR UPDATE`;

        const dayEnd = await tx.workDayEnd.findUnique({
          where: { userId_date: { userId: record.userId, date: keys.calendarDay } },
          select: { endedAt: true },
        });
        if (dayEnd?.endedAt) return { ok: false as const, reason: 'DAY_ENDED' as const };

        if (record.kind) {
          // Any record of this kind counts: taken, skipped or auto-skipped. One
          // exception: an auto-skip that End Day made inside the still-open window,
          // on a day that then carried on (End Day was refused or cancelled), gives
          // way to the real break while the window is open.
          const taken = await tx.breakRecord.findFirst({
            where: { userId: record.userId, date: record.date, kind: record.kind },
            select: { id: true, outcome: true, reason: true, startedAt: true, windowClose: true },
          });
          if (taken) {
            if (!isReplaceableAutoSkip(taken, now)) {
              return { ok: false as const, reason: 'ALREADY_TAKEN' as const };
            }
            await tx.breakRecord.delete({ where: { id: taken.id } });
          }
        }
        if (record.approvalStatus === 'PENDING') await assertMonthOpen(tx, record.date);

        const open = await tx.presenceSession.findFirst({
          where: { userId: record.userId, endedAt: null },
          orderBy: { startedAt: 'desc' },
        });
        if (open && (open.type === 'BREAK' || open.type === 'LUNCH')) {
          return { ok: false as const, reason: 'ALREADY_ON_BREAK' as const };
        }
        if (open) {
          await tx.presenceSession.update({
            where: { id: open.id },
            data: { endedAt: now, durationSec: elapsedSec(open.startedAt, now) },
          });
        }

        const session = await tx.presenceSession.create({
          data: {
            userId: record.userId,
            type: record.presenceType,
            date: keys.calendarDay,
            startedAt: now,
          },
        });
        const created = await tx.breakRecord.create({
          data: { ...record, ...clock, presenceSessionId: session.id },
          include: WITH_SESSION,
        });
        return {
          ok: true as const,
          record: breakRowFromPrisma(created),
          presenceSessionId: session.id,
          closedMeeting: !!open,
        };
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { ok: false, reason: 'ALREADY_TAKEN' };
      }
      throw err;
    }
  }

  async createForSession(
    record: NewBreakRecord,
    presenceSessionId: string,
  ): Promise<BreakRecordRow | null> {
    const clock =
      record.approvalStatus === 'PENDING' ? pendingClock(new Date(), await this.slaHours()) : {};
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        if (record.approvalStatus === 'PENDING') await assertMonthOpen(tx, record.date);
        return tx.breakRecord.create({
          data: { ...record, ...clock, presenceSessionId },
          include: WITH_SESSION,
        });
      });
      return breakRowFromPrisma(created);
    } catch (err) {
      // Already recorded (the session is linked, or that break kind exists today).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  async findOpenForUser(userId: string): Promise<BreakRecordRow | null> {
    const row = await this.prisma.breakRecord.findFirst({
      where: { userId, presenceSession: { endedAt: null } },
      include: WITH_SESSION,
      orderBy: { startedAt: 'desc' },
    });
    return row ? breakRowFromPrisma(row) : null;
  }

  async finishBreak(id: string, input: FinishBreak, now: Date): Promise<FinishBreakResult | null> {
    const sla = input.ask?.routing ? await this.slaHours() : 0;
    return this.prisma.$transaction(async (tx) => {
      // The row lock first: a decision landing at the same moment either commits
      // before (and is reopened here with the overrun) or waits for this one, so a
      // record can never end APPROVED with an overrun nobody reviewed.
      const [current] = await tx.$queryRaw<{ approval_status: string; date: string }[]>`
        SELECT approval_status::text AS approval_status, date
          FROM break_records WHERE id = ${id}::uuid FOR UPDATE`;
      if (!current) return null;

      // A record that is or becomes PENDING changes: its month must be open (the
      // shared month lock, taken after the row lock like every decision).
      if (input.ask?.routing || current.approval_status === 'PENDING') {
        await assertMonthOpen(tx, current.date);
      }
      const data: Prisma.BreakRecordUpdateInput = { overrunSec: Math.max(0, input.overrunSec) };
      let becamePending = false;
      if (input.ask) {
        data.overrunAsked = true;
        data.overrunReason = input.ask.reason;
        if (input.ask.routing) {
          data.approverRole = input.ask.routing.approverRole;
          data.approverId = input.ask.routing.approverId;
          if (current.approval_status !== 'PENDING') {
            // Not waiting yet (needed no approval, or was already decided for an
            // early or late start): it is (re)opened with a fresh 48-hour clock.
            becamePending = true;
            Object.assign(data, pendingClock(now, sla), {
              approvalStatus: 'PENDING',
              decidedById: null,
              decidedAt: null,
              decisionNote: null,
            });
          }
        }
      }
      const updated = await tx.breakRecord.update({ where: { id }, data, include: WITH_SESSION });
      return { row: breakRowFromPrisma(updated), becamePending };
    });
  }

  async addComment(id: string, comment: string, now: Date): Promise<BreakRecordRow | null> {
    if (!isUuid(id)) return null;
    const changed = await this.prisma.$transaction(async (tx) => {
      // A waiting skip changes: the month must be open (row lock, then month lock).
      const [current] = await tx.$queryRaw<{ approval_status: string; date: string }[]>`
        SELECT approval_status::text AS approval_status, date
          FROM break_records WHERE id = ${id}::uuid FOR UPDATE`;
      if (!current) return false;
      if (current.approval_status === 'PENDING') await assertMonthOpen(tx, current.date);
      const res = await tx.breakRecord.updateMany({
        where: { id, reason: null, outcome: { in: ['SKIPPED', 'AUTO_SKIPPED'] } },
        data: { reason: comment, commentedAt: now },
      });
      return res.count > 0;
    });
    return changed ? this.findById(id) : null;
  }

  private approvalWhere(f: ApprovalFilter): Prisma.BreakRecordWhereInput {
    const where: Prisma.BreakRecordWhereInput = {};
    if (f.approverAny) {
      where.OR = [
        { approverId: f.approverAny.approverId },
        { approverRole: f.approverAny.approverRole, approverId: null },
      ];
    } else {
      if (f.approverId) where.approverId = f.approverId;
      if (f.approverRole) where.approverRole = f.approverRole;
    }
    if (f.status?.length) where.approvalStatus = { in: f.status };
    else where.approvalStatus = { not: 'NOT_REQUIRED' };
    if (f.date) where.date = f.date;
    if (f.beforeDate) where.date = { lt: f.beforeDate };
    if (f.userId) where.userId = f.userId;
    return where;
  }

  async listApprovals(f: ApprovalFilter): Promise<BreakRecordRow[]> {
    const rows = await this.prisma.breakRecord.findMany({
      where: this.approvalWhere(f),
      include: WITH_SESSION,
      orderBy: [{ date: 'desc' }, { startedAt: 'desc' }],
      skip: f.skip,
      take: f.take,
    });
    return rows.map(breakRowFromPrisma);
  }

  async countApprovals(f: ApprovalFilter): Promise<number> {
    return this.prisma.breakRecord.count({ where: this.approvalWhere(f) });
  }

  async decide(
    id: string,
    expected: BreakApprovalStatus[],
    decision: Decision,
  ): Promise<BreakRecordRow | null> {
    if (!isUuid(id)) return null;
    const clock =
      decision.status === 'PENDING' ? pendingClock(new Date(), await this.slaHours()) : {};
    return this.prisma.$transaction(async (tx) => {
      // Row lock first (the same order as finishBreak), then the month check.
      const [found] = await tx.$queryRaw<{ date: string }[]>`
        SELECT date FROM break_records WHERE id = ${id}::uuid FOR UPDATE`;
      if (!found) return null;
      // 409 MONTH_LOCKED, and a lock can never slip in between check and write.
      await assertMonthOpen(tx, found.date);
      const res = await tx.breakRecord.updateMany({
        where: { id, approvalStatus: { in: expected } },
        data: {
          approvalStatus: decision.status,
          decidedById: decision.decidedById,
          decidedAt: decision.decidedAt,
          decisionNote: decision.note,
          ...clock,
        },
      });
      if (res.count === 0) return null;
      const row = await tx.breakRecord.findUnique({ where: { id }, include: WITH_SESSION });
      return row ? breakRowFromPrisma(row) : null;
    });
  }

  async reroute(id: string, routing: Routing): Promise<boolean> {
    const res = await this.prisma.breakRecord.updateMany({
      where: { id, approvalStatus: 'PENDING' },
      data: { approverRole: routing.approverRole, approverId: routing.approverId },
    });
    return res.count > 0;
  }
}
