import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { IDLE_READER, IdleReader } from '../../domain/idle-reader.port';
import { localDateString } from '../presence-date.util';
import { PresenceTimelineBucket, UserTimelineView } from '../presence.types';

/** Overlap (seconds) between [aStart,aEnd] and [bStart,bEnd]. */
function overlapSec(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, Math.round((end - start) / 1000));
}

const pad = (n: number) => n.toString().padStart(2, '0');

/**
 * One report's day split into hourly buckets: active (work) seconds from online
 * sessions, plus break/lunch/meeting seconds from presence sessions. Manager-scoped.
 */
@Injectable()
export class GetUserTimelineUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    @Inject(IDLE_READER) private readonly idle: IdleReader,
  ) {}

  async execute(managerId: string, userId: string, date?: string): Promise<UserTimelineView> {
    const now = new Date();
    const day = date ?? localDateString(now);

    const reports = await this.team.findReports(managerId);
    if (!reports.some((r) => r.id === userId)) {
      throw new ForbiddenException('That user is not one of your reports.');
    }

    const sessions = await this.sessions.listForUserByDate(userId, day);
    const intervals = await this.online.listIntervalsForUserByDate(userId, day);
    const idleIntervals = await this.idle.listIdleIntervalsForUserByDate(userId, day);

    const dayStart = new Date(`${day}T00:00:00`); // local midnight
    const buckets: PresenceTimelineBucket[] = [];

    for (let h = 0; h < 24; h++) {
      const bStart = new Date(dayStart.getTime() + h * 3_600_000);
      const bEnd = new Date(bStart.getTime() + 3_600_000);

      let workSec = 0;
      for (const iv of intervals) workSec += overlapSec(iv.start, iv.end, bStart, bEnd);

      let idleSec = 0;
      for (const iv of idleIntervals) idleSec += overlapSec(iv.start, iv.end, bStart, bEnd);

      let breakSec = 0;
      let lunchSec = 0;
      let meetingSec = 0;
      for (const s of sessions) {
        const end = s.endedAt ?? now;
        const o = overlapSec(s.startedAt, end, bStart, bEnd);
        if (o === 0) continue;
        if (s.type === 'BREAK') breakSec += o;
        else if (s.type === 'LUNCH') lunchSec += o;
        else if (s.type === 'MEETING') meetingSec += o;
      }

      buckets.push({
        start: `${pad(bStart.getHours())}:${pad(bStart.getMinutes())}`,
        workSec,
        breakSec,
        lunchSec,
        meetingSec,
        idleSec,
      });
    }

    return { userId, date: day, buckets };
  }
}
