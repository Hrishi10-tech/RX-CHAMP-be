import { Inject, Injectable } from '@nestjs/common';
import { AccountDisabledError, InvalidCredentialsError } from '@shared/exceptions/app.exception';
import { TOKEN_SERVICE, TokenService } from '@shared/security/token.service.port';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserMapper } from '@modules/users/application/mappers/user.mapper';
import {
  USER_REPOSITORY,
  UserRepository,
} from '@modules/users/domain/repositories/user.repository';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenMeta,
  RefreshTokenRepository,
} from '../../domain/refresh-token.repository';
import { AgentActivatedEvent } from '../../domain/events/agent-activated.event';
import { LoginResult } from '../auth.types';

/**
 * Password-less sign-in for a pre-configured agent. The agent presents the
 * per-user enrollment token that was baked into its download; we verify it,
 * confirm the user is still active, and issue a normal session (same tokens as
 * login). Disabling the user makes their token stop working — that's revocation.
 */
@Injectable()
export class EnrollAgentUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(enrollmentToken: string, meta: RefreshTokenMeta): Promise<LoginResult> {
    let userId: string;
    let enrollVersion: number;
    try {
      ({ userId, enrollVersion } = await this.tokens.verifyEnrollmentToken(enrollmentToken));
    } catch {
      throw new InvalidCredentialsError();
    }

    const user = await this.users.findById(userId);
    if (!user) throw new InvalidCredentialsError();
    // 4.0: a key sign-out or a "sign out everywhere" password reset moves the
    // version on, so installers and setup codes issued before it stop working.
    if (enrollVersion !== user.enrollVersion) {
      throw new InvalidCredentialsError(
        'This installer or setup code is no longer valid. Ask your admin for a new one.',
      );
    }

    // The enrollment token already proved who this is, so naming the real reason
    // leaks nothing — and it stops the agent retrying against a blocked account.
    if (!user.isActive()) {
      throw new AccountDisabledError(
        'Your account has been blocked. Contact your manager or an administrator.',
      );
    }

    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });
    const { token: refreshToken } = await this.refreshTokens.issue(user.id, meta);

    // First activation only: tell whoever oversees them (4.0: the department's
    // managers or the organisation's Admin, resolved by the notifications module).
    // The repository stamp is atomic, so this fires exactly once per user.
    const firstActivation = await this.users.markAgentActivatedIfFirst(user.id);
    if (firstActivation) {
      await this.events.publish(
        AgentActivatedEvent.eventName,
        new AgentActivatedEvent(user.managerId, user.id, user.name, new Date()),
      );
    }

    return { user: UserMapper.toPublic(user), accessToken, refreshToken };
  }
}
