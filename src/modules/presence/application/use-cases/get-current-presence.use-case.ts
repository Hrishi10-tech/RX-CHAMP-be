import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import {
  WORK_SESSION_STATE_READER,
  WorkSessionStateReader,
  notStarted,
} from '../../domain/work-session-state.reader';
import { presenceScope } from './get-user-history.use-case';
import { PresenceMapper } from '../presence.mapper';
import { localDateString } from '../presence-date.util';
import { CurrentPresenceView } from '../presence.types';

@Injectable()
export class GetCurrentPresenceUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    @Inject(WORK_SESSION_STATE_READER) private readonly workSessions: WorkSessionStateReader,
  ) {}

  /**
   * Someone else's current status, for a manager (their reports) or a Super
   * Admin (anyone). Opening a person's dashboard seeds its status from this,
   * because `presence:update` only fires on a change.
   */
  async forMember(
    me: Pick<AuthenticatedUser, 'id' | 'role'>,
    userId: string,
  ): Promise<CurrentPresenceView> {
    await presenceScope(this.team, me, userId);
    return this.execute(userId);
  }

  async execute(userId: string): Promise<CurrentPresenceView> {
    const now = new Date();
    const states = await this.workSessions.statesFor([userId], now);
    const state = states.get(userId);
    // The person's working day (an overnight shift's early hours belong to the evening).
    const today = state?.today ?? localDateString(now);
    const open = await this.sessions.findOpenForUser(userId);
    const ended = await this.dayEnds.findEnd(userId, today);
    return PresenceMapper.currentFrom(open, now, ended !== null, notStarted(state));
  }
}
