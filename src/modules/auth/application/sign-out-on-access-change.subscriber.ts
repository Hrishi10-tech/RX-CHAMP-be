import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@modules/users/domain/events/user-access-changed.event';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

/**
 * Ends every session of someone who was blocked or deleted, or whose password
 * an administrator reset with "sign out everywhere". Requests are already
 * refused for inactive accounts; this also stops their refresh tokens from
 * lingering until they expire.
 */
@Injectable()
export class SignOutOnAccessChangeSubscriber implements OnModuleInit {
  private readonly logger = new Logger(SignOutOnAccessChangeSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  async handle(e: UserAccessChangedEvent): Promise<void> {
    if (
      !e.changes.some(
        (c) => c === 'DELETED' || c === 'SIGN_OUT' || (c === 'STATUS' && e.active === false),
      )
    )
      return;
    const n = await this.refreshTokens.revokeAllForUser(e.userId);
    if (n) this.logger.log(`signed ${e.userId} out of ${n} session(s)`);
  }
}
