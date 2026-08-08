import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import { localDateString } from '../presence-date.util';
import { PresenceMapper } from '../presence.mapper';
import { TodayPresenceView } from '../presence.types';

/** The signed-in user's own day: current status, totals, and every session today. */
@Injectable()
export class GetMyTodayUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
  ) {}

  async execute(userId: string, date?: string): Promise<TodayPresenceView> {
    const now = new Date();
    const day = date ?? localDateString(now);

    const all = await this.sessions.listForUserByDate(userId, day);
    const open = all.find((s) => s.endedAt === null) ?? null;
    const ended = await this.dayEnds.findEnd(userId, day);

    // Ending the day closes every open session at that instant, so the totals
    // below are already final — `asOf` only guards a read that races the close.
    const asOf = PresenceMapper.asOf(now, ended?.endedAt ?? null);

    const totals = PresenceMapper.totals(all, asOf);
    totals.onlineSec = await this.online.sumSecondsForUserByDate(userId, day, asOf);

    return {
      date: day,
      current: PresenceMapper.currentFrom(open, asOf, ended !== null),
      totals,
      sessions: all.map((s) => PresenceMapper.toSessionView(s, asOf)),
    };
  }
}
