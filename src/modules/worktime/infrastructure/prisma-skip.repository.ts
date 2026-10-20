import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { assertMonthOpen, isMonthLocked } from '@shared/database/month-lock';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakRecordRow, NewBreakRecord } from '@modules/shifts/domain/break-record.repository';
import {
  BREAK_ROW_INCLUDE,
  breakRowFromPrisma,
  pendingClock,
} from '@modules/shifts/infrastructure/prisma-break-record.repository';
import { AgentGeneration } from '../domain/agent-generation';
import { CreateSkipResult, SkipRepository } from '../domain/skip.repository';
import { ensureOpenTx, lockUser } from './prisma-work-session.repository';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class PrismaSkipRepository implements SkipRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
  ) {}

  async createSkip(
    record: NewBreakRecord,
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<CreateSkipResult> {
    const clock =
      record.approvalStatus === 'PENDING'
        ? pendingClock(now, (await this.settings.forUser(record.userId)).approvalSlaHours)
        : {};
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockUser(tx, record.userId);
        const open = await tx.workSession.findFirst({
          where: { userId: record.userId, endedAt: null },
          select: { id: true },
        });
        if (!open) {
          // Judged before anything is written, so a refused skip never opens a day.
          if (generation === 'AGENT_31') {
            const todaySessions = await tx.workSession.count({
              where: { userId: record.userId, date: today },
            });
            return {
              ok: false as const,
              code: todaySessions ? ('DAY_ENDED' as const) : ('DAY_NOT_STARTED' as const),
            };
          }
          const end = await tx.workDayEnd.findUnique({
            where: { userId_date: { userId: record.userId, date: today } },
            select: { endedAt: true },
          });
          if (end?.endedAt) return { ok: false as const, code: 'DAY_ENDED' as const };
        }
        if (record.kind) {
          const taken = await tx.breakRecord.findFirst({
            where: { userId: record.userId, date: record.date, kind: record.kind },
            select: { id: true },
          });
          if (taken) return { ok: false as const, code: 'BREAK_ALREADY_TAKEN' as const };
        }
        const onBreak = await tx.presenceSession.findFirst({
          where: { userId: record.userId, endedAt: null, type: { in: ['BREAK', 'LUNCH'] } },
          select: { id: true },
        });
        if (onBreak) return { ok: false as const, code: 'ALREADY_ON_BREAK' as const };
        if (record.approvalStatus === 'PENDING')
          await assertMonthOpen(tx, record.date, record.userId);
        if (!open) {
          const day = await ensureOpenTx(tx, record.userId, generation, now, today);
          if (!day.ok) return { ok: false as const, code: day.code };
        }
        const created = await tx.breakRecord.create({
          data: { ...record, outcome: 'SKIPPED', ...clock },
          include: BREAK_ROW_INCLUDE,
        });
        return { ok: true as const, record: breakRowFromPrisma(created) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, code: 'BREAK_ALREADY_TAKEN' };
      throw err;
    }
  }

  async createAutoSkips(records: NewBreakRecord[], now: Date): Promise<BreakRecordRow[]> {
    if (!records.length) return [];
    const out: BreakRecordRow[] = [];
    for (const record of records) {
      const sla = (await this.settings.forUser(record.userId)).approvalSlaHours;
      try {
        const created = await this.prisma.$transaction(async (tx) => {
          // Never a new pending item in a locked month (left out, not an error).
          if (
            record.approvalStatus === 'PENDING' &&
            (await isMonthLocked(tx, record.date, record.userId))
          ) {
            return null;
          }
          return tx.breakRecord.create({
            data: {
              ...record,
              outcome: 'AUTO_SKIPPED',
              ...(record.approvalStatus === 'PENDING' ? pendingClock(now, sla) : {}),
            },
            include: BREAK_ROW_INCLUDE,
          });
        });
        if (created) out.push(breakRowFromPrisma(created));
      } catch (err) {
        // Taken, skipped or auto-skipped meanwhile: the unique key keeps one record.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return out;
  }
}
