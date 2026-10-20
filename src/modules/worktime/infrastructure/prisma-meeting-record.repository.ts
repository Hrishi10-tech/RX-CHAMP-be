import { Injectable } from '@nestjs/common';
import { MeetingRecord, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { ConflictError } from '@shared/exceptions/app.exception';
import { assertMonthOpen } from '@shared/database/month-lock';
import { RequestClock } from '@shared/tenancy';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { Routing } from '@modules/shifts/domain/break-record.repository';
import { ApproverRole, BreakApprovalStatus } from '@modules/shifts/domain/shift.types';
import { pendingClock } from '@modules/shifts/infrastructure/prisma-break-record.repository';
import { isUuid } from '@modules/shifts/infrastructure/prisma-shift.repository';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AgentGeneration } from '../domain/agent-generation';
import { checkPastMeeting, isDiscardedMeeting } from '../domain/meetings';
import {
  CreatePastResult,
  EndLiveResult,
  HealResult,
  MeetingDecision,
  MeetingParticipantData,
  MeetingRecordRepository,
  MeetingRecordRow,
  MIN_LIVE_MEETING_SEC,
  NewMeeting,
  StartLiveResult,
} from '../domain/meeting-record.repository';
import { ensureOpenTx, lockUser } from './prisma-work-session.repository';

function participantsOf(value: Prisma.JsonValue): MeetingParticipantData[] {
  if (!Array.isArray(value)) return [];
  const out: MeetingParticipantData[] = [];
  for (const p of value) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const o = p as Record<string, unknown>;
    if (typeof o.name !== 'string') continue;
    out.push(typeof o.id === 'string' ? { id: o.id, name: o.name } : { name: o.name });
  }
  return out;
}

export function meetingFromPrisma(r: MeetingRecord): MeetingRecordRow {
  return {
    id: r.id,
    userId: r.userId,
    date: r.date,
    mode: r.mode,
    agenda: r.agenda,
    participants: participantsOf(r.participants),
    momSender: r.momSender,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationSec: r.durationSec,
    presenceSessionId: r.presenceSessionId,
    approvalStatus: r.approvalStatus as BreakApprovalStatus,
    approverRole: (r.approverRole as ApproverRole | null) ?? null,
    approverId: r.approverId,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    dueAt: r.dueAt,
    escalatedAt: r.escalatedAt,
    remindedAt: r.remindedAt,
    createdAt: r.createdAt,
  };
}

function seconds(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
}

/**
 * A live meeting under a minute is discarded (SPEC 1.6): kept as NOT_REQUIRED so
 * ending it again still answers `discarded`, and left out of every list.
 */
const NOT_DISCARDED: Prisma.MeetingRecordWhereInput = {
  NOT: {
    mode: 'LIVE',
    approvalStatus: 'NOT_REQUIRED',
    endedAt: { not: null },
    durationSec: { lt: MIN_LIVE_MEETING_SEC },
  },
};

const DISCARD = {
  approvalStatus: 'NOT_REQUIRED' as const,
  approverRole: null,
  approverId: null,
  dueAt: null,
  escalatedAt: null,
  remindedAt: null,
};

@Injectable()
export class PrismaMeetingRecordRepository implements MeetingRecordRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
  ) {}

  /** The SLA clock of a pending item, in the person's organisation. */
  private async clockFor(status: string, now: Date, userId: string | null) {
    if (status !== 'PENDING') return {};
    const settings = userId ? await this.settings.forUser(userId) : await this.settings.get();
    return pendingClock(now, settings.approvalSlaHours);
  }

  async findById(id: string): Promise<MeetingRecordRow | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.meetingRecord.findUnique({ where: { id } });
    return row ? meetingFromPrisma(row) : null;
  }

  async listByIds(ids: string[]): Promise<MeetingRecordRow[]> {
    const wanted = [...new Set(ids)].filter(isUuid);
    if (!wanted.length) return [];
    const rows = await this.prisma.meetingRecord.findMany({ where: { id: { in: wanted } } });
    return rows.map(meetingFromPrisma);
  }

  async listForUserOnDate(userId: string, date: string): Promise<MeetingRecordRow[]> {
    const rows = await this.prisma.meetingRecord.findMany({
      where: { userId, date, ...NOT_DISCARDED },
      orderBy: { startedAt: 'asc' },
    });
    return rows.map(meetingFromPrisma);
  }

  async listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<MeetingRecordRow[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.meetingRecord.findMany({
      where: { userId: { in: userIds }, date: { gte: fromDate, lte: toDate }, ...NOT_DISCARDED },
      orderBy: [{ date: 'asc' }, { startedAt: 'asc' }],
    });
    return rows.map(meetingFromPrisma);
  }

  async startLive(
    input: NewMeeting,
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<StartLiveResult> {
    const clock = await this.clockFor(input.approvalStatus, now, input.userId);
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, input.userId);
      const open = await tx.workSession.findFirst({
        where: { userId: input.userId, endedAt: null },
        select: { id: true, date: true },
      });
      if (!open && generation === 'AGENT_31') {
        const todaySessions = await tx.workSession.count({
          where: { userId: input.userId, date: today },
        });
        return {
          ok: false as const,
          code: todaySessions ? ('DAY_ENDED' as const) : ('DAY_NOT_STARTED' as const),
        };
      }
      const presence = await tx.presenceSession.findFirst({
        where: { userId: input.userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (presence && (presence.type === 'BREAK' || presence.type === 'LUNCH')) {
        return { ok: false as const, code: 'ON_BREAK' as const };
      }
      if (presence?.type === 'MEETING') {
        return { ok: false as const, code: 'MEETING_IN_PROGRESS' as const };
      }
      // The meeting belongs to the working day of the session it runs in.
      let date = open?.date ?? today;
      if (!open) {
        const day = await ensureOpenTx(tx, input.userId, generation, now, today);
        if (!day.ok) return { ok: false as const, code: day.code };
        date = day.session.date;
      }
      if (input.approvalStatus === 'PENDING') await assertMonthOpen(tx, date, input.userId);
      const session = await tx.presenceSession.create({
        data: {
          userId: input.userId,
          type: 'MEETING',
          note: input.agenda,
          date: dateKeyInZone(now, appTimezone()),
          startedAt: now,
        },
      });
      const record = await tx.meetingRecord.create({
        data: {
          userId: input.userId,
          date,
          mode: 'LIVE',
          agenda: input.agenda,
          participants: input.participants as unknown as Prisma.InputJsonValue,
          momSender: input.momSender ?? null,
          startedAt: now,
          presenceSessionId: session.id,
          approvalStatus: input.approvalStatus,
          approverRole: input.routing.approverRole,
          approverId: input.routing.approverId,
          ...clock,
        },
      });
      return {
        ok: true as const,
        record: meetingFromPrisma(record),
        presenceSessionId: session.id,
        closedSessionType: null,
      };
    });
  }

  async endLive(id: string, userId: string, now: Date): Promise<EndLiveResult | null> {
    if (!isUuid(id)) return null;
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const record = await tx.meetingRecord.findUnique({ where: { id } });
      if (!record || record.userId !== userId) return null;
      const row = meetingFromPrisma(record);
      if (isDiscardedMeeting(row)) return { kind: 'DISCARDED' as const };
      if (record.mode !== 'LIVE' || record.endedAt) {
        return { kind: 'UNCHANGED' as const, record: row };
      }
      // A waiting meeting changes: its month must be open (never locked while one waits).
      if (record.approvalStatus === 'PENDING')
        await assertMonthOpen(tx, record.date, record.userId);
      let endedAt = now;
      if (record.presenceSessionId) {
        const session = await tx.presenceSession.findUnique({
          where: { id: record.presenceSessionId },
        });
        if (session && !session.endedAt) {
          await tx.presenceSession.update({
            where: { id: session.id },
            data: { endedAt: now, durationSec: seconds(session.startedAt, now) },
          });
        } else if (session?.endedAt) {
          endedAt = session.endedAt;
        }
      }
      const durationSec = seconds(record.startedAt, endedAt);
      if (durationSec < MIN_LIVE_MEETING_SEC) {
        await tx.meetingRecord.update({
          where: { id },
          data: { endedAt, durationSec, ...DISCARD },
        });
        return { kind: 'DISCARDED' as const };
      }
      const updated = await tx.meetingRecord.update({
        where: { id },
        data: { endedAt, durationSec },
      });
      return { kind: 'ENDED' as const, record: meetingFromPrisma(updated) };
    });
  }

  async createPast(
    input: NewMeeting & { startedAt: Date; durationSec: number },
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<CreatePastResult> {
    const clock = await this.clockFor(input.approvalStatus, now, input.userId);
    const start = input.startedAt;
    const end = new Date(start.getTime() + input.durationSec * 1000);
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, input.userId);
      // Sessions of the working day: today's (shift-day) and the open one, which
      // may have started on the evening before (a night shift past midnight).
      const sessions = await tx.workSession.findMany({
        where: { userId: input.userId, OR: [{ date: today }, { endedAt: null }] },
      });
      if (!sessions.length && generation === 'AGENT_31') {
        return { ok: false as const, code: 'DAY_NOT_STARTED' as const };
      }
      const around = {
        userId: input.userId,
        startedAt: { lt: end },
        OR: [{ endedAt: null }, { endedAt: { gt: start } }],
      };
      const [presence, meetings] = await Promise.all([
        tx.presenceSession.findMany({ where: around }),
        tx.meetingRecord.findMany({ where: { ...around, ...NOT_DISCARDED } }),
      ]);
      const conflict = checkPastMeeting({
        start,
        end,
        now,
        sessions,
        breaks: presence
          .filter((p) => p.type === 'BREAK' || p.type === 'LUNCH')
          .map((p) => ({
            type: p.type as 'BREAK' | 'LUNCH',
            startedAt: p.startedAt,
            endedAt: p.endedAt,
          })),
        meetings: [
          // A presence meeting under a minute was a discarded live meeting.
          ...presence.filter(
            (p) =>
              p.type === 'MEETING' &&
              (p.endedAt === null ||
                p.endedAt.getTime() - p.startedAt.getTime() >= MIN_LIVE_MEETING_SEC * 1000),
          ),
          ...meetings.map((m) => ({
            startedAt: m.startedAt,
            endedAt: m.endedAt ?? (m.mode === 'LIVE' ? null : m.startedAt),
          })),
        ],
      });
      if (conflict) return { ok: false as const, conflict };
      // Dated by the session that holds it (the evening before, for a night shift).
      const covering = sessions.find(
        (w) =>
          w.startedAt.getTime() <= start.getTime() && end.getTime() <= (w.endedAt ?? now).getTime(),
      );
      const date = covering?.date ?? today;
      if (input.approvalStatus === 'PENDING') await assertMonthOpen(tx, date, input.userId);
      const record = await tx.meetingRecord.create({
        data: {
          userId: input.userId,
          date,
          mode: 'PAST',
          agenda: input.agenda,
          participants: input.participants as unknown as Prisma.InputJsonValue,
          momSender: input.momSender ?? null,
          startedAt: start,
          endedAt: end,
          durationSec: input.durationSec,
          approvalStatus: input.approvalStatus,
          approverRole: input.routing.approverRole,
          approverId: input.routing.approverId,
          ...clock,
        },
      });
      return { ok: true as const, record: meetingFromPrisma(record) };
    });
  }

  async heal(userIds: string[] | null): Promise<HealResult> {
    if (userIds && !userIds.length) return { healed: [], discarded: 0 };
    const users = userIds ? Prisma.sql`AND m.user_id = ANY(${userIds}::uuid[])` : Prisma.empty;
    const ids = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE meeting_records m
         SET ended_at = ps.ended_at,
             duration_sec = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (ps.ended_at - m.started_at))))::int,
             updated_at = (now() AT TIME ZONE 'UTC')
        FROM presence_sessions ps
       WHERE m.presence_session_id = ps.id
         AND m.ended_at IS NULL
         AND ps.ended_at IS NOT NULL
         ${users}
      RETURNING m.id::text AS id`;
    // A live meeting whose presence session is gone entirely cannot run on.
    const orphans = await this.prisma.meetingRecord.findMany({
      where: {
        mode: 'LIVE',
        endedAt: null,
        presenceSessionId: null,
        ...(userIds ? { userId: { in: userIds } } : {}),
      },
      select: { id: true, startedAt: true },
    });
    const all = [...ids.map((r) => r.id), ...orphans.map((o) => o.id)];
    if (!all.length) return { healed: [], discarded: 0 };
    // An orphan ends where it started; it and any meeting under a minute are discarded.
    for (const o of orphans) {
      await this.prisma.meetingRecord.updateMany({
        where: { id: o.id, endedAt: null },
        data: { endedAt: o.startedAt, durationSec: 0, ...DISCARD },
      });
    }
    const rows = ids.length
      ? await this.prisma.meetingRecord.findMany({ where: { id: { in: ids.map((r) => r.id) } } })
      : [];
    const short = rows.filter((r) => (r.durationSec ?? 0) < MIN_LIVE_MEETING_SEC).map((r) => r.id);
    if (short.length) {
      await this.prisma.meetingRecord.updateMany({ where: { id: { in: short } }, data: DISCARD });
    }
    return {
      healed: rows.filter((r) => !short.includes(r.id)).map(meetingFromPrisma),
      discarded: short.length + orphans.length,
    };
  }

  async decide(
    id: string,
    expected: BreakApprovalStatus[],
    decision: MeetingDecision,
  ): Promise<MeetingRecordRow | null> {
    if (!isUuid(id)) return null;
    const owner =
      decision.status === 'PENDING'
        ? await this.prisma.meetingRecord.findUnique({ where: { id }, select: { userId: true } })
        : null;
    const clock = await this.clockFor(decision.status, RequestClock.now(), owner?.userId ?? null);
    return this.prisma.$transaction(async (tx) => {
      const [found] = await tx.$queryRaw<
        { date: string; ended_at: Date | null; user_id: string }[]
      >`
        SELECT date, ended_at, user_id::text AS user_id FROM meeting_records WHERE id = ${id}::uuid FOR UPDATE`;
      if (!found) return null;
      await assertMonthOpen(tx, found.date, found.user_id);
      if (!found.ended_at && decision.status !== 'PENDING') {
        throw new ConflictError(
          'This meeting is still running. Decide it once it has ended.',
          'MEETING_IN_PROGRESS',
        );
      }
      const res = await tx.meetingRecord.updateMany({
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
      const row = await tx.meetingRecord.findUnique({ where: { id } });
      return row ? meetingFromPrisma(row) : null;
    });
  }

  async reroute(id: string, routing: Routing): Promise<boolean> {
    const res = await this.prisma.meetingRecord.updateMany({
      where: { id, approvalStatus: 'PENDING' },
      data: { approverRole: routing.approverRole, approverId: routing.approverId },
    });
    return res.count > 0;
  }

  async listPendingForApprover(approverId: string): Promise<MeetingRecordRow[]> {
    const rows = await this.prisma.meetingRecord.findMany({
      where: { approverId, approvalStatus: 'PENDING' },
      take: 500,
    });
    return rows.map(meetingFromPrisma);
  }

  async listPendingForUser(userId: string): Promise<MeetingRecordRow[]> {
    const rows = await this.prisma.meetingRecord.findMany({
      where: { userId, approvalStatus: 'PENDING' },
      take: 500,
    });
    return rows.map(meetingFromPrisma);
  }
}
