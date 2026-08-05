import { Injectable } from '@nestjs/common';
import { OnlineSession as PrismaOnlineSession } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { TimeInterval } from '@shared/types/common.types';
import { elapsedSeconds } from '../application/presence-date.util';
import { OnlineSessionRepository } from '../domain/online-session.repository';

@Injectable()
export class PrismaOnlineSessionRepository implements OnlineSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async heartbeat(
    userId: string,
    date: string,
    now: Date,
    graceSec: number,
    deviceId?: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const open = await tx.onlineSession.findFirst({
        where: { userId, endedAt: null },
        orderBy: { startedAt: 'desc' },
      });

      const withinGrace =
        open !== null &&
        open.date === date &&
        elapsedSeconds(open.lastSeenAt, now) <= graceSec;

      if (withinGrace) {
        await tx.onlineSession.update({ where: { id: open!.id }, data: { lastSeenAt: now } });
        return;
      }

      // Close any stale session at its last-seen time (never count the gap).
      if (open) {
        await tx.onlineSession.update({
          where: { id: open.id },
          data: { endedAt: open.lastSeenAt, durationSec: elapsedSeconds(open.startedAt, open.lastSeenAt) },
        });
      }

      await tx.onlineSession.create({
        data: { userId, deviceId: deviceId ?? null, date, startedAt: now, lastSeenAt: now },
      });
    });
  }

  async closeOpenForUser(userId: string, now: Date): Promise<void> {
    const open = await this.prisma.onlineSession.findFirst({
      where: { userId, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    if (!open) return;
    await this.prisma.onlineSession.update({
      where: { id: open.id },
      data: { endedAt: open.lastSeenAt, durationSec: elapsedSeconds(open.startedAt, open.lastSeenAt) },
    });
  }

  async sumSecondsForUserByDate(userId: string, date: string, now: Date): Promise<number> {
    const rows = await this.prisma.onlineSession.findMany({ where: { userId, date } });
    return rows.reduce((sum, r) => sum + this.seconds(r), 0);
  }

  async sumSecondsForUsersByDate(
    userIds: string[],
    date: string,
    now: Date,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (userIds.length === 0) return result;
    const rows = await this.prisma.onlineSession.findMany({
      where: { userId: { in: userIds }, date },
    });
    for (const r of rows) {
      result.set(r.userId, (result.get(r.userId) ?? 0) + this.seconds(r));
    }
    return result;
  }

  async sumSecondsForUserByDates(
    userId: string,
    dates: string[],
    now: Date,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (dates.length === 0) return result;
    const rows = await this.prisma.onlineSession.findMany({
      where: { userId, date: { in: dates } },
    });
    for (const r of rows) {
      result.set(r.date, (result.get(r.date) ?? 0) + this.seconds(r));
    }
    return result;
  }

  async listIntervalsForUserByDate(userId: string, date: string): Promise<TimeInterval[]> {
    const rows = await this.prisma.onlineSession.findMany({
      where: { userId, date },
      orderBy: { startedAt: 'asc' },
    });
    return rows.map((r) => ({ start: r.startedAt, end: r.endedAt ?? r.lastSeenAt }));
  }

  /** Closed sessions use their recorded duration; open ones count up to last-seen. */
  private seconds(r: PrismaOnlineSession): number {
    if (r.endedAt) return r.durationSec ?? elapsedSeconds(r.startedAt, r.endedAt);
    return elapsedSeconds(r.startedAt, r.lastSeenAt);
  }
}
