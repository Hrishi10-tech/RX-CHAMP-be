import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '@modules/users/users.module';
import { LoginUserUseCase } from './application/use-cases/login-user.use-case';
import { EnrollAgentUseCase } from './application/use-cases/enroll-agent.use-case';
import { RefreshTokenUseCase } from './application/use-cases/refresh-token.use-case';
import { LogoutUserUseCase } from './application/use-cases/logout-user.use-case';
import { AuthController } from './presentation/auth.controller';
import { AuthCookieService } from './presentation/auth-cookie.service';
import { JwtStrategy } from './infrastructure/jwt.strategy';
import { AUTH_USER_READER } from './domain/auth-user-reader.port';
import { PrismaAuthUserReader } from './infrastructure/prisma-auth-user-reader';
import { REFRESH_TOKEN_REPOSITORY } from './domain/refresh-token.repository';
import { PrismaRefreshTokenRepository } from './infrastructure/prisma-refresh-token.repository';

@Module({
  imports: [UsersModule, PassportModule],
  controllers: [AuthController],
  providers: [
    LoginUserUseCase,
    EnrollAgentUseCase,
    RefreshTokenUseCase,
    LogoutUserUseCase,
    AuthCookieService,
    JwtStrategy,
    { provide: AUTH_USER_READER, useClass: PrismaAuthUserReader },
    { provide: REFRESH_TOKEN_REPOSITORY, useClass: PrismaRefreshTokenRepository },
  ],
})
export class AuthModule {}
