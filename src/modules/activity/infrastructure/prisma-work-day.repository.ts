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
    // ended: the conditional update is atomic, so of two simultaneous End Days
    // exactly one sees count=1 and drives the one-shot event.
    await this.prisma.workDayEnd.createMany({ data: [{ userId, date }], skipDuplicates: true });
    const res = await this.prisma.workDayEnd.updateMany({
      where: { userId, date, endedAt: null },
      data: { endedAt },
    });
    const row = await this.prisma.workDayEnd.findUniqueOrThrow({
      where: { userId_date: { userId, date } },
    });
    return { record: this.toEndRecord(row), created: res.count > 0 };
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
    // First report of the day sets the login; later reports never move it. Both
    // steps are atomic, so two first reports arriving together cannot collide
    // on the (user, date) key.
    await this.prisma.workDayEnd.createMany({
      data: [{ userId, date, loginAt }],
      skipDuplicates: true,
    });
    await this.prisma.workDayEnd.updateMany({
      where: { userId, date, loginAt: null },
      data: { loginAt },
    });
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
