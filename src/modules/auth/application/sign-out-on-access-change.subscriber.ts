import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import {
  UserAccessChangedEvent,
  endsCredentials,
} from '@modules/users/domain/events/user-access-changed.event';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

/**
 * Ends what a change to someone's access must end.
 *
 * Refresh tokens: revoked for someone who was blocked or deleted, or whose
 * password an administrator reset with "sign out everywhere". Requests are already
 * refused for inactive accounts; this also stops their refresh tokens from
 * lingering until they expire.
 *
 * Everything else a person holds (access tokens, socket tickets, the desktop
 * app's enrollment token) is bound to their auth epoch, raised here for those
 * changes and also for a role or manager change and an unblock. A device whose
 * refresh token survived (a role or manager change) gets one refused request,
 * refreshes and carries on; an enrollment token needs a new setup code.
 */
@Injectable()
export class SignOutOnAccessChangeSubscriber implements OnModuleInit {
  private readonly logger = new Logger(SignOutOnAccessChangeSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  async handle(e: UserAccessChangedEvent): Promise<void> {
    try {
      // The epoch first: it is what refuses the tokens already out there.
      if (endsCredentials(e)) await this.users.raiseAuthEpoch(e.userId);
    } finally {
      // Whatever became of the epoch, the refresh tokens still go.
      await this.revokeRefreshTokens(e);
    }
  }

  private async revokeRefreshTokens(e: UserAccessChangedEvent): Promise<void> {
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
