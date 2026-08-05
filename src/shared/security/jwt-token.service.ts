import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AccessTokenPayload, TokenService } from './token.service.port';

interface EnrollmentClaims {
  sub: string;
  typ: string;
}

@Injectable()
export class JwtTokenService implements TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async signAccessToken(payload: AccessTokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }

  async signEnrollmentToken(userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, typ: 'enroll' },
      {
        secret: this.config.get<string>('jwt.enrollSecret'),
        expiresIn: this.config.get<string>('jwt.enrollTtl') ?? '365d',
      },
    );
  }

  async verifyEnrollmentToken(token: string): Promise<string> {
    let claims: EnrollmentClaims;
    try {
      claims = await this.jwt.verifyAsync<EnrollmentClaims>(token, {
        secret: this.config.get<string>('jwt.enrollSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired enrollment token.');
    }
    if (claims.typ !== 'enroll' || !claims.sub) {
      throw new UnauthorizedException('Not an enrollment token.');
    }
    return claims.sub;
  }
}
