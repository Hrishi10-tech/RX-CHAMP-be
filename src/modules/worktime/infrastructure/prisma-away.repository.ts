import { Injectable } from '@nestjs/common';
import { AwayEvent, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { assertMonthOpen } from '@shared/database/month-lock';
import { ApproverRole } from '@modules/shifts/domain/shift.types';
import { isUuid } from '@modules/shifts/infrastructure/prisma-shift.repository';
import {
  AwayDecision,
  AwayKind,
  AwayRepository,
  AwayRow,
  AwayStatus,
  CreateAwayResult,
  NewAway,
} from '../domain/away.repository';
import { MeetingParticipantData } from '../domain/meeting-record.repository';
import { lockUser } from './prisma-work-session.repository';

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

export function awayFromPrisma(r: AwayEvent): AwayRow {
  return {
    id: r.id,
    userId: r.userId,
    companyId: r.companyId,
    date: r.date,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    seconds: r.seconds,
    reasonKey: r.reasonKey,
    reasonKind: (r.reasonKind as AwayKind | null) ?? null,
    reasonLabel: r.reasonLabel,
    comment: r.comment,
    participants: participantsOf(r.participants),
    momSender: r.momSender,
    status: r.status as AwayStatus,
    approverRole: (r.approverRole as ApproverRole | null) ?? null,
    decidedById: r.decidedById,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    dueAt: r.dueAt,
    escalatedAt: r.escalatedAt,
    remindedAt: r.remindedAt,
    createdAt: r.createdAt,
  };
}

@Injectable()
export class PrismaAwayRepository implements AwayRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: NewAway): Promise<CreateAwayResult> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, input.userId);
      const overlap = await tx.awayEvent.findFirst({
        where: {
          userId: input.userId,
          startedAt: { lt: input.endedAt },
          OR: [{ endedAt: null }, { endedAt: { gt: input.startedAt } }],
        },
        orderBy: { startedAt: 'asc' },
      });
      if (overlap)
        return { ok: false as const, code: 'OVERLAP' as const, existing: awayFromPrisma(overlap) };
      if (input.status === 'PENDING') await assertMonthOpen(tx, input.date, input.userId);
      const seconds = Math.max(
        0,
        Math.round((input.endedAt.getTime() - input.startedAt.getTime()) / 1000),
      );
      const row = await tx.awayEvent.create({
        data: {
          userId: input.userId,
          companyId: input.companyId,
          date: input.date,
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          seconds,
          reasonKey: input.reasonKey,
          reasonKind: input.reasonKind,
          reasonLabel: input.reasonLabel,
          comment: input.comment,
          participants: input.participants as unknown as Prisma.InputJsonValue,
          momSender: input.momSender,
          status: input.status,
          approverRole: input.approverRole,
          dueAt: input.dueAt,
        },
      });
      return { ok: true as const, row: awayFromPrisma(row) };
    });
  }

  async findById(id: string): Promise<AwayRow | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.awayEvent.findUnique({ where: { id } });
    return row ? awayFromPrisma(row) : null;
  }

  async listByIds(ids: string[]): Promise<AwayRow[]> {
    const wanted = [...new Set(ids)].filter(isUuid);
    if (!wanted.length) return [];
    const rows = await this.prisma.awayEvent.findMany({ where: { id: { in: wanted } } });
    return rows.map(awayFromPrisma);
  }

  async listForUsers(userIds: string[], fromDate: string, toDate: string): Promise<AwayRow[]> {
    const ids = [...new Set(userIds)].filter(isUuid);
    if (!ids.length) return [];
    const rows = await this.prisma.awayEvent.findMany({
      where: { userId: { in: ids }, date: { gte: fromDate, lte: toDate } },
      orderBy: [{ startedAt: 'asc' }],
    });
    return rows.map(awayFromPrisma);
  }

  async reroutePending(userId: string, approverRole: ApproverRole): Promise<number> {
    if (!isUuid(userId)) return 0;
    const res = await this.prisma.awayEvent.updateMany({
      where: { userId, status: 'PENDING', NOT: { approverRole } },
      data: { approverRole },
    });
    return res.count;
  }

  async decide(
    id: string,
    expected: AwayStatus[],
    decision: AwayDecision,
  ): Promise<AwayRow | null> {
    if (!isUuid(id)) return null;
    return this.prisma.$transaction(async (tx) => {
      const [found] = await tx.$queryRaw<{ date: string; user_id: string }[]>`
        SELECT date, user_id::text AS user_id FROM away_events WHERE id = ${id}::uuid FOR UPDATE`;
      if (!found) return null;
      await assertMonthOpen(tx, found.date, found.user_id);
      const res = await tx.awayEvent.updateMany({
        where: { id, status: { in: expected } },
        data: {
          status: decision.status,
          decidedById: decision.decidedById,
          decidedAt: decision.decidedAt,
          decisionNote: decision.note,
          ...(decision.status === 'PENDING'
            ? { dueAt: decision.dueAt ?? null, escalatedAt: null, remindedAt: null }
            : {}),
        },
      });
      if (res.count === 0) return null;
      const row = await tx.awayEvent.findUnique({ where: { id } });
      return row ? awayFromPrisma(row) : null;
    });
  }
}
