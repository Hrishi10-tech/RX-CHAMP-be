import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../domain/presence-session.repository';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../domain/online-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../domain/presence-team-reader.port';
import { PresenceGateway } from '../presentation/presence.gateway';
import { PresenceMapper } from './presence.mapper';

/**
 * Stops attendance the moment the user ends their working day. Anything still
 * open is closed at `endedAt` — an open break/lunch/meeting, and the online
 * session behind the heartbeat — so no total can keep growing afterwards. The
 * manager's presence board is then pushed to DAY_ENDED, since no further
 * heartbeat will arrive to update it.
 */
@Injectable()
export class DayEndedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(DayEndedSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    private readonly gateway: PresenceGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<DayEndedEvent>(DayEndedEvent.eventName, (e) => this.handle(e));
  }

  private async handle(event: DayEndedEvent): Promise<void> {
    // Close the break/lunch/meeting at the End Day instant, and the online
    // session at its last heartbeat — never credit the gap in between.
    await this.sessions.endOpenForUser(event.userId, event.endedAt);
    await this.online.closeOpenForUser(event.userId, event.endedAt);

    if (event.managerId) {
      const context = await this.team.findContext(event.userId);
      if (context) {
        this.gateway.emitToManager(
          event.managerId,
          PresenceMapper.toTeamMemberView(
            context.self,
            PresenceMapper.currentFrom(null, event.endedAt, true),
          ),
        );
      }
    }

    this.logger.debug(`presence closed for ${event.userId} at ${event.endedAt.toISOString()}`);
  }
}
