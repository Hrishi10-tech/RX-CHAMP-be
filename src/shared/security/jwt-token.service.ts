import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  AccessTokenPayload,
  EnrollmentClaims,
  SOCKET_TICKET_TTL_SEC,
  SOCKET_TOKEN_TYPE,
  TokenService,
  epochOf,
} from './token.service.port';

interface EnrollmentTokenBody {
  sub: string;
  typ: string;
  /** 4.0: the person's enrollVersion when issued. */
  ev?: number;
  ep?: unknown;
  mb?: unknown;
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

  async signEnrollmentToken(
    userId: string,
    binding: { enrollVersion?: number; epoch: number; mintedBy: string },
  ): Promise<string> {
    return this.jwt.signAsync(
      {
        sub: userId,
        typ: 'enroll',
        ev: binding.enrollVersion ?? 1,
        ep: binding.epoch,
        mb: binding.mintedBy,
      },
      {
        secret: this.config.get<string>('jwt.enrollSecret'),
        expiresIn: this.config.get<string>('jwt.enrollTtl') ?? '365d',
      },
    );
  }

  async verifyEnrollmentToken(token: string): Promise<EnrollmentClaims> {
    let claims: EnrollmentTokenBody;
    try {
      claims = await this.jwt.verifyAsync<EnrollmentTokenBody>(token, {
        secret: this.config.get<string>('jwt.enrollSecret'),
        // Only what we sign with: the header never gets to pick the algorithm.
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired enrollment token.');
    }
    if (claims.typ !== 'enroll' || !claims.sub) {
      throw new UnauthorizedException('Not an enrollment token.');
    }
    // Tokens from before 4.0 carry no version: they were issued for version 1.
    const ev = Number.isInteger(claims.ev) && (claims.ev as number) > 0 ? (claims.ev as number) : 1;
    return {
      userId: claims.sub,
      enrollVersion: ev,
      epoch: epochOf(claims),
      mintedBy: typeof claims.mb === 'string' && claims.mb ? claims.mb : null,
    };
  }
}
