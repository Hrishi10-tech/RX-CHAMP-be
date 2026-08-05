import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { localDateString } from '../presence-date.util';
import { PresenceMapper } from '../presence.mapper';
import { TodayPresenceView } from '../presence.types';

/** The signed-in user's own day: current status, totals, and every session today. */
@Injectable()
export class GetMyTodayUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
  ) {}

  async execute(userId: string, date?: string): Promise<TodayPresenceView> {
    const now = new Date();
    const day = date ?? localDateString(now);

    const all = await this.sessions.listForUserByDate(userId, day);
    const open = all.find((s) => s.endedAt === null) ?? null;

    const totals = PresenceMapper.totals(all, now);
    totals.onlineSec = await this.online.sumSecondsForUserByDate(userId, day, now);

    return {
      date: day,
      current: PresenceMapper.currentFrom(open, now),
      totals,
      sessions: all.map((s) => PresenceMapper.toSessionView(s, now)),
    };
  }
}
