import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import { PresenceMapper } from '../presence.mapper';
import { localDateString } from '../presence-date.util';
import { CurrentPresenceView } from '../presence.types';

@Injectable()
export class GetCurrentPresenceUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
  ) {}

  async execute(userId: string): Promise<CurrentPresenceView> {
    const now = new Date();
    const open = await this.sessions.findOpenForUser(userId);
    const ended = await this.dayEnds.findEnd(userId, localDateString(now));
    return PresenceMapper.currentFrom(open, now, ended !== null);
  }
}
