import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AccountDisabledError,
  InvalidCredentialsError,
  TooManyAttemptsError,
} from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { TOKEN_SERVICE, TokenService } from '@shared/security/token.service.port';
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
import { LoginResult } from '../auth.types';
import { FailedLoginsByAddress } from '../failed-logins-by-address.service';
import { LoginAttempts } from '../login-attempts.service';

/**
 * A bcrypt hash of a random string, compared against when the email is unknown,
 * so a wrong address costs the same time as a wrong password and response
 * timing does not reveal which addresses have accounts.
 */
const DUMMY_HASH = '$2b$12$hVG8LYketny5CvVKPlTX5e7bGNzivkm1.Y3s5iAkdg1iMavvShH1m';

/** The desktop agent's User-Agent: "RXVisionAgent/3.0.0 (windows)". */
const AGENT_USER_AGENT = /^RXVisionAgent\//;

/** An account that signed in from an address this recently may still sign in from it when the address is over its failure limit. */
const KNOWN_ADDRESS_MS = 30 * 24 * 3_600_000;

function tooManyFromAddress(minutes: number): TooManyAttemptsError {
  return new TooManyAttemptsError(
    `Too many failed sign-ins from your network. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
  );
}

@Injectable()
export class LoginUserUseCase {
  private readonly logger = new Logger(LoginUserUseCase.name);

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    private readonly attempts: LoginAttempts = new LoginAttempts(),
    @Optional() @Inject(EVENT_BUS) private readonly events?: EventBus,
    @Optional()
    private readonly byAddress: FailedLoginsByAddress = new FailedLoginsByAddress(),
  ) {}

  async execute(email: string, password: string, meta: RefreshTokenMeta): Promise<LoginResult> {
    const address = (email ?? '').toLowerCase().trim();
    this.attempts.assertAllowed(address);
    const now = Date.now();

    const user = await this.users.findByEmail(address);
    // Over the client address's failed sign-in limit, only accounts that signed in
    // from that address before may try (their password is not even checked
    // otherwise), so spraying stops while the office behind it keeps working.
    const blockedMin = this.byAddress.blockedForMin(meta.ip, now);
    if (blockedMin > 0) {
      const known =
        !!user &&
        !!meta.ip &&
        (await this.refreshTokens.signedInFrom(user.id, meta.ip, new Date(now - KNOWN_ADDRESS_MS)));
      if (!known) throw tooManyFromAddress(blockedMin);
    }

    if (!user) {
      try {
        await this.hasher.compare(password ?? '', DUMMY_HASH);
      } catch {
        // Only here to spend the same time as a real check.
      }
      this.failed(address, meta.ip, now);
      throw new InvalidCredentialsError();
    }

    // Password first, THEN status. Checking status first would let anyone probe
    // which addresses belong to blocked accounts without knowing the password;
    // this way only someone with valid credentials is told they're blocked.
    const passwordOk = await this.hasher.compare(password ?? '', user.passwordHash);
    if (!passwordOk) {
      this.failed(address, meta.ip, now);
      // Over the address limit a wrong password answers 429, never a plain 401.
      const minutes = this.byAddress.blockedForMin(meta.ip, now);
      if (blockedMin > 0 && minutes > 0) throw tooManyFromAddress(minutes);
      throw new InvalidCredentialsError();
    }
    this.attempts.recordSuccess(address);

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
    if (meta.userAgent && AGENT_USER_AGENT.test(meta.userAgent)) await this.agentActivated(user);
    return { user: UserMapper.toPublic(user), accessToken, refreshToken };
  }

  /** A wrong password counts against the account and against the client address. */
  private failed(address: string, ip: string | null, now: number): void {
    this.attempts.recordFailure(address);
    this.byAddress.recordFailure(ip, now);
  }

  /**
   * Signing the desktop agent in with a password sets it up just as an enrollment
   * does; without this the portal would show "Not activated" for ever for anyone
   * who never used a per-user download or setup code. Never fails the sign-in.
   */
  private async agentActivated(user: User): Promise<void> {
    try {
      const first = await this.users.markAgentActivatedIfFirst(user.id);
      if (first && user.managerId && this.events) {
        await this.events.publish(
          AgentActivatedEvent.eventName,
          new AgentActivatedEvent(user.managerId, user.id, user.name, new Date()),
        );
      }
    } catch (err) {
      this.logger.warn(`could not record the agent activation: ${(err as Error).message}`);
    }
  }
}
