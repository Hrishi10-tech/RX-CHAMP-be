import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { addDaysToKey, appTimezone, startOfDayInZone } from '@shared/utils/timezone';
import { MeetingWindow, MeetingWindowReader } from '../domain/meeting-window.reader';

/**
 * A person's meetings overlapping [from, to): live ones, and logged ones a manager has not
 * rejected. Read by time, not by their stored date: a meeting is filed under the day it began
 * (a logged one under its session's working day) and samples under the calendar day they fall
 * on, so past midnight the two differ (3.6, D-22).
 */
export async function meetingWindowsBetween(
  prisma: PrismaService,
  userId: string,
  from: Date,
  to: Date,
): Promise<MeetingWindow[]> {
  const [live, logged] = await Promise.all([
    prisma.presenceSession.findMany({
      where: {
        userId,
        type: 'MEETING',
        startedAt: { lt: to },
        OR: [{ endedAt: null }, { endedAt: { gt: from } }],
      },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true, endedAt: true },
    }),
    prisma.meetingRecord.findMany({
      where: {
        userId,
        mode: 'PAST',
        approvalStatus: { not: 'REJECTED' },
        startedAt: { lt: to },
        endedAt: { gt: from },
      },
      orderBy: { startedAt: 'asc' },
      select: { startedAt: true, endedAt: true },
    }),
  ]);
  return [...live, ...logged].map((r) => ({ start: r.startedAt, end: r.endedAt }));
}

@Injectable()
export class PrismaMeetingWindowReader implements MeetingWindowReader {
  constructor(private readonly prisma: PrismaService) {}

  listForUserByDate(userId: string, date: string): Promise<MeetingWindow[]> {
    const tz = appTimezone();
    return meetingWindowsBetween(
      this.prisma,
      userId,
      startOfDayInZone(date, tz),
      startOfDayInZone(addDaysToKey(date, 1), tz),
    );
  }

  async usersInMeeting(userIds: string[]): Promise<Set<string>> {
    if (!userIds.length) return new Set();
    const rows = await this.prisma.presenceSession.findMany({
      where: { userId: { in: userIds }, type: 'MEETING', endedAt: null },
      select: { userId: true },
      distinct: ['userId'],
    });
    return new Set(rows.map((r) => r.userId));
  }
}
