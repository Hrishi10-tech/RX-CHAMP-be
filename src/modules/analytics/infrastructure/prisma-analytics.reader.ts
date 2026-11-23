import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { addDaysToKey, appTimezone, startOfDayInZone } from '@shared/utils/timezone';
import { ActivitySampleRecord } from '@modules/activity/domain/activity-sample.repository';
import { MeetingWindow } from '@modules/activity/domain/meeting-window.reader';
import { meetingWindowsBetween } from '@modules/activity/infrastructure/prisma-meeting-window.reader';
import {
  AnalyticsReader,
  AnalyticsWindow,
  OnlineRow,
  PresenceRow,
} from '../domain/analytics.reader';

@Injectable()
export class PrismaAnalyticsReader implements AnalyticsReader {
  constructor(private readonly prisma: PrismaService) {}

  async findManagerId(userId: string): Promise<string | null | undefined> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { managerId: true },
    });
    return row ? row.managerId : undefined;
  }

  async loadWindow(userId: string, dates: string[]): Promise<AnalyticsWindow> {
    const tz = appTimezone();
    const boundsOf = (d: string) => ({
      from: startOfDayInZone(d, tz),
      to: startOfDayInZone(addDaysToKey(d, 1), tz),
    });
    const sorted = [...dates].sort();
    const [samples, online, presence, meetings] = await Promise.all([
      this.prisma.activitySample.findMany({
        where: { userId, date: { in: dates } },
        orderBy: { at: 'asc' },
      }),
      this.prisma.onlineSession.findMany({
        where: { userId, date: { in: dates } },
        orderBy: { startedAt: 'asc' },
        select: { date: true, startedAt: true, endedAt: true, durationSec: true },
      }),
      this.prisma.presenceSession.findMany({
        where: { userId, date: { in: dates } },
        orderBy: { startedAt: 'asc' },
        select: { date: true, type: true, startedAt: true, endedAt: true, durationSec: true },
      }),
      sorted.length
        ? meetingWindowsBetween(
            this.prisma,
            userId,
            boundsOf(sorted[0]).from,
            boundsOf(sorted[sorted.length - 1]).to,
          )
        : Promise.resolve<MeetingWindow[]>([]),
    ]);

    const samplesByDate = new Map<string, ActivitySampleRecord[]>();
    for (const r of samples) {
      const list = samplesByDate.get(r.date) ?? [];
      list.push({
        id: r.id,
        userId: r.userId,
        deviceId: r.deviceId,
        date: r.date,
        at: r.at,
        durationSec: r.durationSec,
        idle: r.idle,
        locked: r.locked,
        app: r.app,
        title: r.title,
        url: r.url,
      });
      samplesByDate.set(r.date, list);
    }

    const onlineByDate = new Map<string, OnlineRow[]>();
    for (const r of online) {
      const list = onlineByDate.get(r.date) ?? [];
      list.push({ startedAt: r.startedAt, endedAt: r.endedAt, durationSec: r.durationSec });
      onlineByDate.set(r.date, list);
    }

    const presenceByDate = new Map<string, PresenceRow[]>();
    for (const r of presence) {
      const list = presenceByDate.get(r.date) ?? [];
      list.push({
        type: r.type as PresenceRow['type'],
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        durationSec: r.durationSec,
      });
      presenceByDate.set(r.date, list);
    }

    const meetingsByDate = new Map(
      dates.map((d) => {
        const { from, to } = boundsOf(d);
        return [d, meetings.filter((m) => m.start < to && (m.end === null || m.end > from))];
      }),
    );

    return { samplesByDate, onlineByDate, presenceByDate, meetingsByDate };
  }
}
