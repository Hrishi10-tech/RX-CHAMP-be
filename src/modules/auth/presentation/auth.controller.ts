import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
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
