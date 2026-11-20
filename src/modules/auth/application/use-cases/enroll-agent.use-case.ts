import { Inject, Injectable } from '@nestjs/common';
import { AccountDisabledError, InvalidCredentialsError } from '@shared/exceptions/app.exception';
import { EnrollmentClaims, TOKEN_SERVICE, TokenService } from '@shared/security/token.service.port';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserMapper } from '@modules/users/application/mappers/user.mapper';
import { User } from '@modules/users/domain/entities/user.entity';
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
import { mayMintEnrollmentFor } from '../../domain/enrollment-mint-rule';
import { AUTH_USER_READER, AuthUserReader } from '../../domain/auth-user-reader.port';
import { LoginResult } from '../auth.types';

/**
 * Password-less sign-in for a pre-configured agent. The agent presents the
 * per-user enrollment token that was baked into its download; we verify it,
 * confirm it still stands, and issue a normal session (same tokens as login).
 *
 * A token stands while the person's auth epoch is the one it was minted under
 * (a sign-out everywhere, a block or unblock, a delete, a role or manager change
 * all raise it) and while whoever minted it for them is still active and could
 * still mint it today. A token that no longer stands gets the answer a bad token
 * gets: the person needs a new setup code.
 */
@Injectable()
export class EnrollAgentUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(AUTH_USER_READER) private readonly authUsers: AuthUserReader,
  ) {}

  async execute(enrollmentToken: string, meta: RefreshTokenMeta): Promise<LoginResult> {
    let claims: EnrollmentClaims;
    try {
      claims = await this.tokens.verifyEnrollmentToken(enrollmentToken);
    } catch {
      throw new InvalidCredentialsError();
    }

    const user = await this.users.findById(claims.userId);
    if (!user) throw new InvalidCredentialsError();
    // 4.0: a key sign-out or a "sign out everywhere" password reset moves the
    // version on, so installers and setup codes issued before it stop working.
    if (claims.enrollVersion !== user.enrollVersion) {
      throw new InvalidCredentialsError(
        'This installer or setup code is no longer valid. Ask your admin for a new one.',
      );
    }

    const epoch = await this.users.authEpochOf(user.id);
    if (epoch === null || claims.epoch !== epoch) throw new InvalidCredentialsError();
    if (!(await this.minterStillStands(claims.mintedBy, user))) {
      throw new InvalidCredentialsError();
    }

    // A current enrollment token already proved who this is, so naming the real
    // reason leaks nothing, and it stops the agent retrying against a blocked account.
    if (!user.isActive()) {
      throw new AccountDisabledError(
        'Your account has been blocked. Contact your manager or an administrator.',
      );
    }

    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      ep: epoch,
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

  /**
   * A token someone else minted is only as good as that person's right to mint it:
   * they must still exist, be active and pass the mint-time rule for this subject.
   * A token from before the minter was recorded has nobody else to answer for it.
   */
  private async minterStillStands(mintedBy: string | null, subject: User): Promise<boolean> {
    if (!mintedBy) return true;
    // 4.0: the minter is read as they would act in the subject's organisation (a
    // Super Admin minted it with that organisation in view).
    const minter = await this.authUsers.loadById(mintedBy, subject.companyId);
    if (!minter || minter.status !== 'ACTIVE') return false;
    return mayMintEnrollmentFor(minter, subject);
  }
}
