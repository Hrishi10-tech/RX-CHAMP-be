import { Inject, Injectable } from '@nestjs/common';
import { API_COPY } from '@shared/copy/api-copy';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OtherDevicesSignedOutEvent } from '@shared/events/other-devices-signed-out.event';
import { UnauthorizedError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { TOKEN_SERVICE, TokenService } from '@shared/security/token.service.port';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import { MIN_PASSWORD_LENGTH } from '@modules/users/application/user.constants';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenMeta,
  RefreshTokenRepository,
} from '../../domain/refresh-token.repository';

/**
 * Self-service password change. The current password is required, so a session
 * left open on a shared machine cannot be used to take the account over. This
 * device gets a fresh session; other devices keep theirs unless asked otherwise.
 */
@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(
    me: AuthenticatedUser,
    currentPassword: string,
    newPassword: string,
    signOutOtherDevices: boolean,
    meta: RefreshTokenMeta,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const user = await this.users.findById(me.id);
    if (!user || !user.isActive()) throw new UnauthorizedError(API_COPY.accountOff);

    if (!(await this.hasher.compare(currentPassword ?? '', user.passwordHash))) {
      throw new ValidationError('Your current password is not right.', 'WRONG_PASSWORD');
    }
    const next = newPassword ?? '';
    if (next.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, 'WEAK_PASSWORD');
    }
    if (next === currentPassword) {
      throw new ValidationError('Pick a password you are not using now.', 'SAME_PASSWORD');
    }

    user.setPasswordHash(await this.hasher.hash(next));
    await this.users.save(user);
    if (signOutOtherDevices) {
      await this.refreshTokens.revokeAllForUser(user.id);
      // Refresh tokens alone leave the other devices their access tokens, socket
      // tickets and the desktop app's enrollment token. Raising the epoch ends
      // those too. Awaited here, not left to a subscriber: the token signed below
      // must carry the new value.
      await this.users.raiseAuthEpoch(user.id);
    }

    // This device's new session, minted under the current epoch, so it carries on
    // with the cookies in this response and never sees a refusal.
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      ep: (await this.users.authEpochOf(user.id)) ?? 0,
    });
    const { token: refreshToken } = await this.refreshTokens.issue(user.id, meta);

    // Last, once this device's new session exists: live sockets and phone pushes
    // follow this event.
    if (signOutOtherDevices) {
      await this.events.publish(
        OtherDevicesSignedOutEvent.eventName,
        new OtherDevicesSignedOutEvent(user.id),
      );
    }
    return { accessToken, refreshToken };
  }
}
