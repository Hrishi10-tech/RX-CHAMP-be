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
      // Serialise status changes per person (shared with the scheduled-break
      // start), so two taps can never leave two sessions open.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${data.userId}::uuid FOR UPDATE`;
      const open = await tx.presenceSession.findMany({
        where: { userId: data.userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });

      let closed: PresenceSessionRecord | null = null;
      for (const s of open) {
        const row = await tx.presenceSession.update({
          where: { id: s.id },
          data: { endedAt: now, durationSec: elapsedSeconds(s.startedAt, now) },
        });
        closed ??= this.toRecord(row);
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
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const open = await tx.presenceSession.findMany({
        where: { userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });
      if (!open.length) return null;

      // Close every open session (normally one; older data may hold strays).
      let newest: PresenceSessionRecord | null = null;
      for (const s of open) {
        const row = await tx.presenceSession.update({
          where: { id: s.id },
          data: { endedAt: now, durationSec: elapsedSeconds(s.startedAt, now) },
        });
        newest ??= this.toRecord(row);
      }
      return newest;
    });
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
