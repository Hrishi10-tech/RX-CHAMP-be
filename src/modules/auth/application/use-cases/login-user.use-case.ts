import { Inject, Injectable } from '@nestjs/common';
import { AccountDisabledError, InvalidCredentialsError } from '@shared/exceptions/app.exception';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { TOKEN_SERVICE, TokenService } from '@shared/security/token.service.port';
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
import { LoginResult } from '../auth.types';

@Injectable()
export class LoginUserUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  async execute(email: string, password: string, meta: RefreshTokenMeta): Promise<LoginResult> {
    const user = await this.users.findByEmail((email ?? '').toLowerCase().trim());
    if (!user) throw new InvalidCredentialsError();

    // Password first, THEN status. Checking status first would let anyone probe
    // which addresses belong to blocked accounts without knowing the password;
    // this way only someone with valid credentials is told they're blocked.
    const passwordOk = await this.hasher.compare(password ?? '', user.passwordHash);
    if (!passwordOk) throw new InvalidCredentialsError();

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
    return { user: UserMapper.toPublic(user), accessToken, refreshToken };
  }
}
