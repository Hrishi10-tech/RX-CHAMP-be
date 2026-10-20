import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UnauthorizedError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { AccessTokenPayload } from '@shared/security/token.service.port';
import { AUTH_USER_READER, AuthUserReader } from '../domain/auth-user-reader.port';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    @Inject(AUTH_USER_READER) private readonly reader: AuthUserReader,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => req?.cookies?.accessToken ?? null,
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('jwt.accessSecret') ?? 'change-me-access',
      passReqToCallback: true,
    });
  }

  async validate(
    req: Request,
    payload: AccessTokenPayload & { typ?: string },
  ): Promise<AuthenticatedUser> {
    // A socket ticket is signed with this same secret, and it is readable by
    // JavaScript — unlike the httpOnly access cookie. Accepting one here would hand
    // anything that scraped a ticket a working API credential, which is exactly what
    // the httpOnly cookie exists to prevent. Handshakes only.
    // Access tokens carry no `typ`. Anything typed (a socket ticket, an installer's
    // enrollment token if a misconfiguration ever signed one with this secret) is
    // never an API credential.
    if (payload.typ !== undefined) {
      throw new UnauthorizedError('Not signed in');
    }

    // 4.0: a Super Admin acts inside the organisation named by X-Org-Id (ignored for
    // everyone else, whose organisation is their own).
    const orgHeader = req?.headers?.['x-org-id'];
    const user = await this.reader.loadById(
      payload.sub,
      Array.isArray(orgHeader) ? orgHeader[0] : orgHeader,
    );
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedError('Account is no longer active');
    }
    return user;
  }
}
