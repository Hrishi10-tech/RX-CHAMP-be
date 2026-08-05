
import { Inject, Injectable } from '@nestjs/common';
import { UnauthorizedError } from '@shared/exceptions/app.exception';
import { TOKEN_SERVICE, TokenService } from '@shared/security/token.service.port';
import { AUTH_USER_READER, AuthUserReader } from '../../domain/auth-user-reader.port';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenMeta,
  RefreshTokenRepository,
} from '../../domain/refresh-token.repository';
import { AuthTokens } from '../auth.types';

@Injectable()
export class RefreshTokenUseCase {
  constructor(
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
    @Inject(REFRESH_TOKEN_REPOSITORY) private readonly refreshTokens: RefreshTokenRepository,
    @Inject(AUTH_USER_READER) private readonly users: AuthUserReader,
  ) {}

  async execute(rawRefreshToken: string | undefined, meta: RefreshTokenMeta): Promise<AuthTokens> {
    if (!rawRefreshToken) throw new UnauthorizedError('Missing refresh token');

    const rotated = await this.refreshTokens.rotate(rawRefreshToken, meta);
    if (!rotated) throw new UnauthorizedError('Invalid or expired refresh token');

    const user = await this.users.loadById(rotated.userId);
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedError('Account is no longer active');
    }

    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
    });

    return { accessToken, refreshToken: rotated.token };
  }
}
