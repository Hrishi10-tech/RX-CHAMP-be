import { Injectable } from '@nestjs/common';
import { WorkDayEnd as PrismaWorkDayEnd } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  WorkDayEndRecord,
  WorkDayRepository,
} from '../domain/work-day.repository';

@Injectable()
export class PrismaWorkDayRepository implements WorkDayRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findEnd(userId: string, date: string): Promise<WorkDayEndRecord | null> {
    const row = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date } },
    });
    return row ? this.toRecord(row) : null;
  }

  async markEnded(userId: string, date: string, endedAt: Date): Promise<WorkDayEndRecord> {
    // Idempotent: create on first End Day; if the day is already ended, keep the
    // original endedAt (the update clause is a no-op).
    const row = await this.prisma.workDayEnd.upsert({
      where: { userId_date: { userId, date } },
      create: { userId, date, endedAt },
      update: {},
    });
    return this.toRecord(row);
  }

  private toRecord(r: PrismaWorkDayEnd): WorkDayEndRecord {
    return { userId: r.userId, date: r.date, endedAt: r.endedAt };
  }
}
