import { Injectable } from '@nestjs/common';
import { Prisma, WorkDayEnd as PrismaWorkDayEnd } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  MarkEndedResult,
  WorkDayEndRecord,
  WorkDayRepository,
} from '../domain/work-day.repository';

/** Prisma's unique-constraint violation — the day was already ended. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class PrismaWorkDayRepository implements WorkDayRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findEnd(userId: string, date: string): Promise<WorkDayEndRecord | null> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
    });
    return row ? this.toRecord(row) : null;
  }

  async findEndsForUsers(userIds: string[], date: string): Promise<Map<string, WorkDayEndRecord>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.prisma.workDayEnd.findMany({
      where: { userId: { in: userIds }, date },
    });
    return new Map(rows.map((r) => [r.userId, this.toRecord(r)]));
  }

  async markEnded(userId: string, date: string, endedAt: Date): Promise<MarkEndedResult> {
    // Insert rather than upsert so the caller can tell a first End Day from a
    // repeat press — only the first one may fire the day-ended event. The unique
    // (userId, date) index makes this safe against two presses racing.
    try {
      const row = await this.prisma.workDayEnd.create({ data: { userId, date, endedAt } });
      return { record: this.toRecord(row), created: true };
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== UNIQUE_VIOLATION) {
        throw e;
      }
    }

    // Already ended: the first endedAt stands.
    const existing = await this.prisma.workDayEnd.findUniqueOrThrow({
      where: { userId_date: { userId, date } },
    });
    return { record: this.toRecord(existing), created: false };
  }

  private toRecord(r: PrismaWorkDayEnd): WorkDayEndRecord {
    return { userId: r.userId, date: r.date, endedAt: r.endedAt };
  }
}
