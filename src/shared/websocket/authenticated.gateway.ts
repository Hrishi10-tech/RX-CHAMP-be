import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayInit } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { SocketHandshakeAuth, SocketTokenClaims } from './socket.types';
import { SocketAccessService, accountRoom } from './socket-access.service';

/**
 * Access token from the `accessToken` cookie, an `Authorization: Bearer` header,
 * or the socket.io `auth.token`. Subclasses declare their own constructor (Nest
 * reads DI metadata off the concrete class) and pass `jwt`, `config` and the
 * shared `SocketAccessService` to `super`.
 */
export abstract class AuthenticatedGateway implements OnGatewayInit {
  protected abstract readonly logger: Logger;
  protected server!: Namespace;

  protected constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly access: SocketAccessService,
  ) {}

  afterInit(server: Namespace): void {
    this.access.track(server);
  }

  protected authenticate(client: Socket): string | null {
    const token = this.tokenFrom(client);
    if (!token) return null;
    try {
      const claims = this.jwt.verify<SocketTokenClaims>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
      // An access token (no typ) or a socket ticket; never any other typed token.
      if (claims.typ !== undefined && claims.typ !== 'socket') return null;
      return claims.sub ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Admits a socket or disconnects it: allowed origin, valid token, and an
   * account that is still active. On success the socket joins its account room
   * (used to drop it when the account is blocked or signed out).
   */
  protected async authenticateOrDisconnect(client: Socket): Promise<string | null> {
    const origin = client.handshake.headers.origin;
    const userId = this.access.originAllowed(origin) ? this.authenticate(client) : null;
    if (!userId || !(await this.access.isActive(userId))) {
      client.emit('unauthorized', { message: 'Not signed in' });
      client.disconnect(true);
      return null;
    }
    await client.join(accountRoom(userId));
    return userId;
  }

  private tokenFrom(client: Socket): string | null {
    const cookie = client.handshake.headers.cookie;
    if (cookie) {
      const match = cookie
        .split(';')
        .map((c) => c.trim())
        .find((c) => c.startsWith('accessToken='));
      if (match) return decodeURIComponent(match.slice('accessToken='.length));
    }
    const authHeader = client.handshake.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
    const authToken = (client.handshake.auth as SocketHandshakeAuth | undefined)?.token;
    if (typeof authToken === 'string') return authToken.replace(/^Bearer\s+/i, '');
    return null;
  }
}
