import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { BcryptHasher } from './bcrypt-hasher';
import { PASSWORD_HASHER } from './password-hasher.port';
import { JwtTokenService } from './jwt-token.service';
import { TOKEN_SERVICE } from './token.service.port';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.accessSecret'),
        signOptions: { expiresIn: config.get<string>('jwt.accessTtl') ?? '15m' },
      }),
    }),
  ],
  providers: [
    BcryptHasher,
    { provide: PASSWORD_HASHER, useExisting: BcryptHasher },
    JwtTokenService,
    { provide: TOKEN_SERVICE, useExisting: JwtTokenService },
  ],
  exports: [PASSWORD_HASHER, TOKEN_SERVICE, JwtModule],
})
export class SecurityModule {}
