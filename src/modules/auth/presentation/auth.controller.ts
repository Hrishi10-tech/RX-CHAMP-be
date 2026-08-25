import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  SOCKET_TICKET_TTL_SEC,
  TOKEN_SERVICE,
  TokenService,
} from '@shared/security/token.service.port';
import { EnrollDto, LoginDto } from '../application/dto';
import { RefreshTokenMeta } from '../domain/refresh-token.repository';
import { LoginUserUseCase } from '../application/use-cases/login-user.use-case';
import { EnrollAgentUseCase } from '../application/use-cases/enroll-agent.use-case';
import { RefreshTokenUseCase } from '../application/use-cases/refresh-token.use-case';
import { LogoutUserUseCase } from '../application/use-cases/logout-user.use-case';
import { AuthCookieService, REFRESH_COOKIE } from './auth-cookie.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly loginUser: LoginUserUseCase,
    private readonly enrollAgent: EnrollAgentUseCase,
    private readonly refreshToken: RefreshTokenUseCase,
    private readonly logoutUser: LogoutUserUseCase,
    private readonly cookies: AuthCookieService,
    @Inject(TOKEN_SERVICE) private readonly tokens: TokenService,
  ) {}

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in; sets httpOnly access + refresh token cookies' })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } = await this.loginUser.execute(
      body.email,
      body.password,
      this.meta(req),
    );
    this.cookies.set(res, { accessToken, refreshToken });
    return { user };
  }

  @Post('enroll')
  @HttpCode(200)
  @ApiOperation({ summary: 'Password-less sign-in for a pre-configured agent (enrollment token)' })
  async enroll(
    @Body() body: EnrollDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } = await this.enrollAgent.execute(
      body.token,
      this.meta(req),
    );
    this.cookies.set(res, { accessToken, refreshToken });
    return { user };
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and re-issue the access cookie' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const tokens = await this.refreshToken.execute(req.cookies?.[REFRESH_COOKIE], this.meta(req));
    this.cookies.set(res, tokens);
    return { refreshed: true };
  }

  @Get('socket-ticket')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Short-lived ticket for a socket.io handshake. Needed because browsers will ' +
      'not send the auth cookie to a socket on a different site, so a cross-origin ' +
      'dashboard cannot authenticate a handshake with cookies alone. Fetch this over ' +
      'same-origin HTTP and pass it as `auth.token` when connecting. Not usable as an ' +
      'API credential.',
  })
  async socketTicket(@CurrentUser() me: AuthenticatedUser) {
    const token = await this.tokens.signSocketTicket({
      sub: me.id,
      email: me.email,
      role: me.role,
    });
    return { token, expiresIn: SOCKET_TICKET_TTL_SEC };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke the refresh token and clear auth cookies' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.logoutUser.execute(req.cookies?.[REFRESH_COOKIE]);
    this.cookies.clear(res);
    return { loggedOut: true };
  }

  private meta(req: Request): RefreshTokenMeta {
    return { userAgent: req.headers['user-agent'] ?? null, ip: req.ip ?? null };
  }
}
