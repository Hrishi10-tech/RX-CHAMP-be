import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { PresenceGateway } from '../../presentation/presence.gateway';
import { PresenceDayGate } from '../presence-day.gate';
import { PresenceMapper } from '../presence.mapper';
import { CurrentPresenceView } from '../presence.types';

/** Ends the user's current break/lunch/meeting — i.e. back to working. */
@Injectable()
export class EndPresenceUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    private readonly gateway: PresenceGateway,
    private readonly day: PresenceDayGate,
  ) {}

  /**
   * `now` is the request's clock (a replayed agent action's own time). A 3.1+
   * agent needs its day open, as for every other agent action.
   */
  async execute(
    userId: string,
    generation: 'AGENT_31' | 'LEGACY' = 'LEGACY',
    now: Date = new Date(),
  ): Promise<CurrentPresenceView> {
    if (generation === 'AGENT_31') await this.day.ensureOpen(userId, generation, now);
    await this.sessions.endOpenForUser(userId, now);

    const current = PresenceMapper.currentFrom(null, now); // now WORKING

    const context = await this.team.findContext(userId);
    if (context) {
      await this.gateway.emitForSubject(
        userId,
        PresenceMapper.toTeamMemberView(context.self, current),
      );
    }

    return current;
  }
}
