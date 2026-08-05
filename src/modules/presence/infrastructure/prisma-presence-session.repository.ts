import { Injectable } from '@nestjs/common';
import { PresenceSession as PrismaPresenceSession } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { elapsedSeconds } from '../application/presence-date.util';
import {
  OpenSessionData,
  PresenceSessionRecord,
  PresenceSessionRepository,
} from '../domain/presence-session.repository';

@Injectable()
export class PrismaPresenceSessionRepository implements PresenceSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findOpenForUser(userId: string): Promise<PresenceSessionRecord | null> {
    const row = await this.prisma.presenceSession.findFirst({
      where: { userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    return row ? this.toRecord(row) : null;
  }

  async switchTo(
    data: OpenSessionData,
    now: Date,
  ): Promise<{ closed: PresenceSessionRecord | null; opened: PresenceSessionRecord }> {
    return this.prisma.$transaction(async (tx) => {
      const open = await tx.presenceSession.findFirst({
        where: { userId: data.userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });

      let closed: PresenceSessionRecord | null = null;
      if (open) {
        const row = await tx.presenceSession.update({
          where: { id: open.id },
          data: { endedAt: now, durationSec: elapsedSeconds(open.startedAt, now) },
        });
        closed = this.toRecord(row);
      }

      const opened = await tx.presenceSession.create({
        data: {
          userId: data.userId,
          deviceId: data.deviceId ?? null,
          type: data.type,
          note: data.note ?? null,
          date: data.date,
          startedAt: now,
        },
      });

      return { closed, opened: this.toRecord(opened) };
    });
  }

  async endOpenForUser(userId: string, now: Date): Promise<PresenceSessionRecord | null> {
    const open = await this.prisma.presenceSession.findFirst({
      where: { userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (!open) return null;

    const row = await this.prisma.presenceSession.update({
      where: { id: open.id },
      data: { endedAt: now, durationSec: elapsedSeconds(open.startedAt, now) },
    });
    return this.toRecord(row);
  }

  async listForUserByDate(userId: string, date: string): Promise<PresenceSessionRecord[]> {
    const rows = await this.prisma.presenceSession.findMany({
      where: { userId, date },
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((r) => this.toRecord(r));
  }

  async listOpenForUsers(userIds: string[]): Promise<PresenceSessionRecord[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.presenceSession.findMany({
      where: { userId: { in: userIds }, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((r) => this.toRecord(r));
  }

  async listForUsersByDate(userIds: string[], date: string): Promise<PresenceSessionRecord[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.presenceSession.findMany({
      where: { userId: { in: userIds }, date },
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((r) => this.toRecord(r));
  }

  async listForUserInDates(userId: string, dates: string[]): Promise<PresenceSessionRecord[]> {
    if (dates.length === 0) return [];
    const rows = await this.prisma.presenceSession.findMany({
      where: { userId, date: { in: dates } },
      orderBy: { startedAt: 'desc' },
    });
    return rows.map((r) => this.toRecord(r));
  }

  private toRecord(row: PrismaPresenceSession): PresenceSessionRecord {
    return {
      id: row.id,
      userId: row.userId,
      deviceId: row.deviceId,
      type: row.type,
      note: row.note,
      date: row.date,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
    };
  }
}
