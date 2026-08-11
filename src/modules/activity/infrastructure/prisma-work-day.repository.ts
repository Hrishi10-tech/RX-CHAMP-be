import { Injectable } from '@nestjs/common';
import { WorkDayEnd as PrismaWorkDayEnd } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  MarkEndedResult,
  WorkDayEndRecord,
  WorkDayRepository,
} from '../domain/work-day.repository';

/**
 * One row per user per local day (`work_day_ends`), holding both the PC login time
 * and the End-Day time. A row can exist for the login alone, so "day ended" means
 * `endedAt IS NOT NULL` — never merely "a row exists".
 */
@Injectable()
export class PrismaWorkDayRepository implements WorkDayRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findEnd(userId: string, date: string): Promise<WorkDayEndRecord | null> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
    });
    return row?.endedAt ? this.toEndRecord(row) : null;
  }

  async findEndsForUsers(userIds: string[], date: string): Promise<Map<string, WorkDayEndRecord>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.workDayEnd.findMany({
      where: { userId: { in: userIds }, date, endedAt: { not: null } },
    });
    return new Map(rows.map((r) => [r.userId, this.toEndRecord(r)]));
  }

  async markEnded(userId: string, date: string, endedAt: Date): Promise<MarkEndedResult> {
    // The row may already exist from the login. End it only if it isn't already
    // ended — the first End Day wins and drives the one-shot event.
    const existing = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
    });

    if (existing?.endedAt) {
      return { record: this.toEndRecord(existing), created: false };
    }

    const row = await this.prisma.workDayEnd.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, endedAt },
      update: { endedAt },
    });
    return { record: this.toEndRecord(row), created: true };
  }

  async clearEnd(userId: string, date: string): Promise<boolean> {
    // Clear only the end time; keep the row (and its login) so Start Day doesn't
    // lose the login time.
    const res = await this.prisma.workDayEnd.updateMany({
      where: { userId, date, endedAt: { not: null } },
      data: { endedAt: null },
    });
    return res.count > 0;
  }

  async recordLogin(userId: string, date: string, loginAt: Date): Promise<void> {
    const existing = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
    });

    // First report of the day sets the login; later reports never move it.
    if (!existing) {
      await this.prisma.workDayEnd.create({ data: { userId, date, loginAt } });
      return;
    }
    if (!existing.loginAt) {
      await this.prisma.workDayEnd.update({
        where: { userId_date: { userId, date } },
        data: { loginAt },
      });
    }
  }

  async findLogin(userId: string, date: string): Promise<Date | null> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
      select: { loginAt: true },
    });
    return row?.loginAt ?? null;
  }

  async findLoginsForUsers(userIds: string[], date: string): Promise<Map<string, Date>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.workDayEnd.findMany({
      where: { userId: { in: userIds }, date, loginAt: { not: null } },
      select: { userId: true, loginAt: true },
    });
    return new Map(rows.map((r) => [r.userId, r.loginAt as Date]));
  }

  private toEndRecord(r: PrismaWorkDayEnd): WorkDayEndRecord {
    // Only called when endedAt is set (see findEnd / markEnded).
    return { userId: r.userId, date: r.date, endedAt: r.endedAt as Date };
  }
}
