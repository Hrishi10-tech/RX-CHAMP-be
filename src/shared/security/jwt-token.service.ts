import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AccessTokenPayload,
  EnrollmentToken,
  SOCKET_TICKET_TTL_SEC,
  SOCKET_TOKEN_TYPE,
  TokenService,
} from './token.service.port';

interface EnrollmentClaims {
  sub: string;
  typ: string;
  /** 4.0: the person's enrollVersion when issued. */
  ev?: number;
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

  async signSocketTicket(payload: AccessTokenPayload): Promise<string> {
    // Signed with the access secret so the gateways verify it with no extra key to
    // manage; `typ` is what keeps it out of the HTTP path (see JwtStrategy).
    return this.jwt.signAsync(
      { ...payload, typ: SOCKET_TOKEN_TYPE },
      { expiresIn: `${SOCKET_TICKET_TTL_SEC}s` },
    );
  }

  async signEnrollmentToken(userId: string, enrollVersion = 1): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, typ: 'enroll', ev: enrollVersion },
      {
        secret: this.config.get<string>('jwt.enrollSecret'),
        expiresIn: this.config.get<string>('jwt.enrollTtl') ?? '365d',
      },
    );
  }

  async verifyEnrollmentToken(token: string): Promise<EnrollmentToken> {
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
    // Tokens from before 4.0 carry no version: they were issued for version 1.
    const ev = Number.isInteger(claims.ev) && (claims.ev as number) > 0 ? (claims.ev as number) : 1;
    return { userId: claims.sub, enrollVersion: ev };
  }
}
