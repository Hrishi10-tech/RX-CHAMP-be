import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { PresenceGateway } from '../../presentation/presence.gateway';
import { PresenceMapper } from '../presence.mapper';
import { CurrentPresenceView } from '../presence.types';

/** Ends the user's current break/lunch/meeting — i.e. back to working. */
@Injectable()
export class EndPresenceUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    private readonly gateway: PresenceGateway,
  ) {}

  async execute(userId: string): Promise<CurrentPresenceView> {
    const now = new Date();
    await this.sessions.endOpenForUser(userId, now);

    const current = PresenceMapper.currentFrom(null, now); // now WORKING

    const context = await this.team.findContext(userId);
    if (context?.managerId) {
      this.gateway.emitToManager(
        context.managerId,
        PresenceMapper.toTeamMemberView(context.self, current),
      );
    }

    return current;
  }
}
