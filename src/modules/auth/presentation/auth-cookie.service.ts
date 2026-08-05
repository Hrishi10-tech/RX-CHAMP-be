
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CookieOptions, Response } from 'express';
import { parseDurationMs } from '@shared/utils/duration';
import { AuthTokens } from '../application/auth.types';

export const ACCESS_COOKIE = 'accessToken';
export const REFRESH_COOKIE = 'refreshToken';

@Injectable()
export class AuthCookieService {
  constructor(private readonly config: ConfigService) {}

  private base(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get<string>('env') === 'production',
      sameSite: 'lax',
    };
  }

  private get refreshPath(): string {
    return `/${this.config.get<string>('apiPrefix') ?? 'api/v1'}/auth`;
  }

  set(res: Response, tokens: AuthTokens): void {
    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...this.base(),
      path: '/',
      maxAge: parseDurationMs(this.config.get<string>('jwt.accessTtl') ?? '15m'),
    });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.base(),
      path: this.refreshPath,
      maxAge: parseDurationMs(this.config.get<string>('jwt.refreshTtl') ?? '7d'),
    });
  }

  clear(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: this.refreshPath });
  }
}
