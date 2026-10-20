import { Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { assertMonthOpen } from '@shared/database/month-lock';
import { RequestClock } from '@shared/tenancy';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import {
  ApprovalFilter,
  BreakMoveResult,
  BreakRecordRepository,
  BreakRecordRow,
  BreakState,
  Decision,
  FinishBreak,
  FinishBreakResult,
  NewBreakRecord,
  NewQuickBreak,
  Routing,
  StartBreakOutcome,
  isReplaceableAutoSkip,
  takenSecOf,
} from '../domain/break-record.repository';
import {
  ApproverRole,
  BreakApprovalStatus,
  BreakOutcome,
  BreakPresenceType,
  BreakTiming,
  RecordKind,
} from '../domain/shift.types';
import { isUuid } from './prisma-shift.repository';

const WITH_SESSION = {
  presenceSession: { select: { endedAt: true } },
  // 4.0: each segment's times come from its presence session when it still has
  // one (whatever path ended the session), else from the segment row itself.
  segments: {
    select: {
      startedAt: true,
      endedAt: true,
      presenceSession: { select: { startedAt: true, endedAt: true } },
    },
    orderBy: { startedAt: 'asc' as const },
  },
} as const;
type Row = Prisma.BreakRecordGetPayload<{ include: typeof WITH_SESSION }>;

export function breakRowFromPrisma(r: Row): BreakRecordRow {
  return {
    id: r.id,
    userId: r.userId,
    date: r.date,
    kind: (r.kind as RecordKind | null) ?? null,
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
    state: r.state as BreakState,
    plannedMin: r.plannedMin,
    finalEndedAt: r.endedAt,
    segments: (r.segments ?? []).map((g) => ({
      startedAt: g.presenceSession?.startedAt ?? g.startedAt,
      endedAt: g.presenceSession ? g.presenceSession.endedAt : g.endedAt,
    })),
  };
}

export const BREAK_ROW_INCLUDE = WITH_SESSION;

function elapsedSec(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

/**
 * The columns every move to PENDING sets: a fresh 48-hour clock, no reminder or
 * escalation yet. 4.0 (re-audit L2): for a replayed agent action the record keeps
 * its own (event) times, but the approver's clock starts when the server receives
 * it, never days in the past.
 */
export function pendingClock(now: Date, slaHours: number) {
  const start = RequestClock.isReplay() ? new Date() : now;
  return {
    dueAt: new Date(start.getTime() + slaHours * 3_600_000),
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

  /** The approval time limit of the person's organisation. */
  private async slaHours(userId: string): Promise<number> {
    return (await this.settings.forUser(userId)).approvalSlaHours;
  }

  /** The approval time limit of the organisation a break record's person belongs to. */
  private async slaHoursOfRecord(id: string): Promise<number> {
    const row = await this.prisma.breakRecord.findUnique({
      where: { id },
      select: { userId: true },
    });
    return row ? this.slaHours(row.userId) : (await this.settings.get()).approvalSlaHours;
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
      record.approvalStatus === 'PENDING'
        ? pendingClock(now, await this.slaHours(record.userId))
        : {};
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
        if (record.approvalStatus === 'PENDING')
          await assertMonthOpen(tx, record.date, record.userId);

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
          data: {
            ...record,
            ...clock,
            presenceSessionId: session.id,
            state: 'ACTIVE',
            segments: { create: { presenceSessionId: session.id, startedAt: now } },
          },
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
      record.approvalStatus === 'PENDING'
        ? pendingClock(RequestClock.now(), await this.slaHours(record.userId))
        : {};
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        if (record.approvalStatus === 'PENDING')
          await assertMonthOpen(tx, record.date, record.userId);
        const session = await tx.presenceSession.findUnique({
          where: { id: presenceSessionId },
          select: { startedAt: true, endedAt: true },
        });
        return tx.breakRecord.create({
          data: {
            ...record,
            ...clock,
            presenceSessionId,
            state: session && !session.endedAt ? 'ACTIVE' : 'ENDED',
            segments: {
              create: {
                presenceSessionId,
                startedAt: session?.startedAt ?? record.startedAt,
                endedAt: session?.endedAt ?? null,
              },
            },
          },
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
    const sla = input.ask?.routing ? await this.slaHoursOfRecord(id) : 0;
    return this.prisma.$transaction(async (tx) => {
      // The row lock first: a decision landing at the same moment either commits
      // before (and is reopened here with the overrun) or waits for this one, so a
      // record can never end APPROVED with an overrun nobody reviewed.
      const [current] = await tx.$queryRaw<
        { approval_status: string; date: string; user_id: string }[]
      >`
        SELECT approval_status::text AS approval_status, date, user_id::text AS user_id
          FROM break_records WHERE id = ${id}::uuid FOR UPDATE`;
      if (!current) return null;

      // A record that is or becomes PENDING changes: its month must be open (the
      // shared month lock, taken after the row lock like every decision).
      if (input.ask?.routing || current.approval_status === 'PENDING') {
        await assertMonthOpen(tx, current.date, current.user_id);
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
      const [current] = await tx.$queryRaw<
        { approval_status: string; date: string; user_id: string }[]
      >`
        SELECT approval_status::text AS approval_status, date, user_id::text AS user_id
          FROM break_records WHERE id = ${id}::uuid FOR UPDATE`;
      if (!current) return false;
      if (current.approval_status === 'PENDING')
        await assertMonthOpen(tx, current.date, current.user_id);
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
    if (f.subjects) {
      where.user = {
        companyId: f.subjects.companyId,
        ...(f.subjects.departmentIds ? { departmentId: { in: f.subjects.departmentIds } } : {}),
        ...(f.subjects.roles ? { role: { name: { in: f.subjects.roles as RoleName[] } } } : {}),
      };
    }
    if (f.adminPool) {
      where.AND = [
        {
          OR: [{ approverRole: { in: ['ADMIN', 'SUPER_ADMIN'] } }, { escalatedAt: { not: null } }],
        },
      ];
    }
    if (f.status?.length) where.approvalStatus = { in: f.status };
    else where.approvalStatus = { not: 'NOT_REQUIRED' };
    if (f.date) where.date = f.date;
    if (f.beforeDate) where.date = { lt: f.beforeDate };
    if (f.userId) where.userId = f.userId;
    else if (f.excludeUserId) where.userId = { not: f.excludeUserId };
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
      decision.status === 'PENDING'
        ? pendingClock(RequestClock.now(), await this.slaHoursOfRecord(id))
        : {};
    return this.prisma.$transaction(async (tx) => {
      // Row lock first (the same order as finishBreak), then the month check.
      const [found] = await tx.$queryRaw<{ date: string; user_id: string }[]>`
        SELECT date, user_id::text AS user_id FROM break_records WHERE id = ${id}::uuid FOR UPDATE`;
      if (!found) return null;
      // 409 MONTH_LOCKED, and a lock can never slip in between check and write.
      await assertMonthOpen(tx, found.date, found.user_id);
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

  // ---- 4.0: quick breaks, pause and resume (docs/4.0/SPEC.md 2.3) -----------------

  /** The person's open presence session (any type), under their lock. */
  private async openPresence(tx: Prisma.TransactionClient, userId: string) {
    return tx.presenceSession.findFirst({
      where: { userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
  }

  /** Whether the person has a work session open (4.0 agents: Start Day pressed). */
  private async dayOpen(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const open = await tx.workSession.findFirst({
      where: { userId, endedAt: null },
      select: { id: true },
    });
    return !!open;
  }

  async startQuick(input: NewQuickBreak, _now: Date): Promise<BreakMoveResult> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${input.userId}::uuid FOR UPDATE`;
      const dayEnd = await tx.workDayEnd.findUnique({
        where: { userId_date: { userId: input.userId, date: input.calendarDay } },
        select: { endedAt: true },
      });
      if (dayEnd?.endedAt) return { ok: false as const, code: 'DAY_ENDED' as const };
      if (!(await this.dayOpen(tx, input.userId))) {
        return { ok: false as const, code: 'DAY_NOT_STARTED' as const };
      }
      const open = await this.openPresence(tx, input.userId);
      if (open && (open.type === 'BREAK' || open.type === 'LUNCH')) {
        return { ok: false as const, code: 'ON_BREAK' as const };
      }
      if (open && open.type === 'MEETING')
        return { ok: false as const, code: 'IN_MEETING' as const };
      // A paused scheduled break stays paused; a quick break may run meanwhile.
      const seq =
        (await tx.breakRecord.count({
          where: { userId: input.userId, date: input.date, kind: 'QUICK' },
        })) + 1;
      const session = await tx.presenceSession.create({
        data: {
          userId: input.userId,
          type: 'BREAK',
          date: input.calendarDay,
          startedAt: input.startedAt,
        },
      });
      const created = await tx.breakRecord.create({
        data: {
          userId: input.userId,
          date: input.date,
          kind: 'QUICK',
          seq,
          presenceType: 'BREAK',
          shiftId: input.shiftId,
          shiftName: input.shiftName,
          startedAt: input.startedAt,
          timing: 'UNSCHEDULED',
          minutesOff: 0,
          source: 'AGENT',
          approvalStatus: 'NOT_REQUIRED',
          presenceSessionId: session.id,
          state: 'ACTIVE',
          plannedMin: input.plannedMin,
          segments: { create: { presenceSessionId: session.id, startedAt: input.startedAt } },
        },
        include: WITH_SESSION,
      });
      return {
        ok: true as const,
        record: breakRowFromPrisma(created),
        presenceSessionId: session.id,
      };
    });
  }

  async pause(id: string, userId: string, now: Date): Promise<BreakMoveResult> {
    if (!isUuid(id)) return { ok: false, code: 'NOT_FOUND' };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const row = await tx.breakRecord.findFirst({ where: { id, userId }, include: WITH_SESSION });
      if (!row) return { ok: false as const, code: 'NOT_FOUND' as const };
      const current = breakRowFromPrisma(row);
      if (row.kind === 'QUICK' || !row.kind) {
        return { ok: false as const, code: 'NOT_PAUSABLE' as const, record: current };
      }
      if (row.state === 'PAUSED' || !row.presenceSessionId || row.presenceSession?.endedAt) {
        return { ok: false as const, code: 'NOT_ACTIVE' as const, record: current };
      }
      const session = await tx.presenceSession.findUnique({ where: { id: row.presenceSessionId } });
      if (session && !session.endedAt) {
        await tx.presenceSession.update({
          where: { id: session.id },
          data: { endedAt: now, durationSec: elapsedSec(session.startedAt, now) },
        });
      }
      await tx.breakSegment.updateMany({
        where: { breakRecordId: id, endedAt: null },
        data: { endedAt: now },
      });
      const updated = await tx.breakRecord.update({
        where: { id },
        data: { state: 'PAUSED' },
        include: WITH_SESSION,
      });
      return { ok: true as const, record: breakRowFromPrisma(updated), presenceSessionId: null };
    });
  }

  async resume(
    id: string,
    userId: string,
    now: Date,
    calendarDay: string,
  ): Promise<BreakMoveResult> {
    if (!isUuid(id)) return { ok: false, code: 'NOT_FOUND' };
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const row = await tx.breakRecord.findFirst({ where: { id, userId }, include: WITH_SESSION });
      if (!row) return { ok: false as const, code: 'NOT_FOUND' as const };
      const current = breakRowFromPrisma(row);
      if (row.state !== 'PAUSED')
        return { ok: false as const, code: 'NOT_PAUSED' as const, record: current };
      if (row.windowClose && now.getTime() > row.windowClose.getTime()) {
        const ended = await this.endPausedTx(tx, id, now);
        return {
          ok: false as const,
          code: 'RESUME_WINDOW_CLOSED' as const,
          record: ended ?? current,
        };
      }
      const dayEnd = await tx.workDayEnd.findUnique({
        where: { userId_date: { userId, date: calendarDay } },
        select: { endedAt: true },
      });
      if (dayEnd?.endedAt)
        return { ok: false as const, code: 'DAY_ENDED' as const, record: current };
      if (!(await this.dayOpen(tx, userId))) {
        return { ok: false as const, code: 'DAY_NOT_STARTED' as const, record: current };
      }
      const open = await this.openPresence(tx, userId);
      if (open && (open.type === 'BREAK' || open.type === 'LUNCH')) {
        return { ok: false as const, code: 'ON_BREAK' as const, record: current };
      }
      if (open && open.type === 'MEETING') {
        return { ok: false as const, code: 'IN_MEETING' as const, record: current };
      }
      const session = await tx.presenceSession.create({
        data: { userId, type: row.presenceType, date: calendarDay, startedAt: now },
      });
      const updated = await tx.breakRecord.update({
        where: { id },
        data: {
          state: 'ACTIVE',
          presenceSessionId: session.id,
          segments: { create: { presenceSessionId: session.id, startedAt: now } },
        },
        include: WITH_SESSION,
      });
      return {
        ok: true as const,
        record: breakRowFromPrisma(updated),
        presenceSessionId: session.id,
      };
    });
  }

  async findPausedForUser(userId: string): Promise<BreakRecordRow | null> {
    const row = await this.prisma.breakRecord.findFirst({
      where: { userId, state: 'PAUSED' },
      include: WITH_SESSION,
      orderBy: { startedAt: 'desc' },
    });
    return row ? breakRowFromPrisma(row) : null;
  }

  /** Ends a paused break at its last segment end (inside a transaction). */
  private async endPausedTx(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<BreakRecordRow | null> {
    const row = await tx.breakRecord.findUnique({ where: { id }, include: WITH_SESSION });
    if (!row || row.state !== 'PAUSED') return row ? breakRowFromPrisma(row) : null;
    const current = breakRowFromPrisma(row);
    const segs = current.segments ?? [];
    const lastEnd = segs.reduce<Date | null>(
      (max, g) => (g.endedAt && (!max || g.endedAt > max) ? g.endedAt : max),
      null,
    );
    const updated = await tx.breakRecord.update({
      where: { id },
      data: {
        state: 'ENDED',
        endedAt: lastEnd ?? current.startedAt,
        takenSec: takenSecOf(current, now),
      },
      include: WITH_SESSION,
    });
    return breakRowFromPrisma(updated);
  }

  async markEnded(id: string, at: Date): Promise<BreakRecordRow | null> {
    if (!isUuid(id)) return null;
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.breakRecord.findUnique({ where: { id }, include: WITH_SESSION });
      if (!row) return null;
      if (row.state === 'PAUSED') return this.endPausedTx(tx, id, at);
      if (row.state === 'ENDED' && row.endedAt) return breakRowFromPrisma(row);
      if (row.presenceSessionId) {
        const session = await tx.presenceSession.findUnique({
          where: { id: row.presenceSessionId },
        });
        if (session && !session.endedAt) {
          await tx.presenceSession.update({
            where: { id: session.id },
            data: { endedAt: at, durationSec: elapsedSec(session.startedAt, at) },
          });
        }
      }
      await tx.breakSegment.updateMany({
        where: { breakRecordId: id, endedAt: null },
        data: { endedAt: at },
      });
      const fresh = await tx.breakRecord.findUnique({ where: { id }, include: WITH_SESSION });
      const current = breakRowFromPrisma(fresh!);
      const updated = await tx.breakRecord.update({
        where: { id },
        data: { state: 'ENDED', endedAt: current.endedAt ?? at, takenSec: takenSecOf(current, at) },
        include: WITH_SESSION,
      });
      return breakRowFromPrisma(updated);
    });
  }

  async endExpiredPaused(now: Date, userId?: string): Promise<number> {
    const rows = await this.prisma.breakRecord.findMany({
      where: { state: 'PAUSED', windowClose: { lt: now }, ...(userId ? { userId } : {}) },
      select: { id: true },
      take: 1000,
    });
    let n = 0;
    for (const r of rows) {
      const done = await this.prisma.$transaction((tx) => this.endPausedTx(tx, r.id, now));
      if (done) n += 1;
    }
    return n;
  }

  async endPaused(userId: string): Promise<number> {
    const rows = await this.prisma.breakRecord.findMany({
      where: { state: 'PAUSED', userId },
      select: { id: true },
    });
    let n = 0;
    for (const r of rows) {
      const done = await this.prisma.$transaction((tx) =>
        this.endPausedTx(tx, r.id, RequestClock.now()),
      );
      if (done) n += 1;
    }
    return n;
  }
}
