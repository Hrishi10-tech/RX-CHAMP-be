import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { SocketHandshakeAuth, SocketTokenClaims } from './socket.types';

/**
 * Access token from the `accessToken` cookie, an `Authorization: Bearer` header,
 * or the socket.io `auth.token`. Subclasses declare their own constructor (Nest
 * reads DI metadata off the concrete class) and pass `jwt` + `config` to `super`.
 */
export abstract class AuthenticatedGateway {
  protected abstract readonly logger: Logger;
  protected server!: Server;

  protected constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  protected authenticate(client: Socket): string | null {
    const token = this.tokenFrom(client);
    if (!token) return null;
    try {
      const claims = this.jwt.verify<SocketTokenClaims>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
      return claims.sub ?? null;
    } catch {
      return null;
    }
  }

  protected authenticateOrDisconnect(client: Socket): string | null {
    const userId = this.authenticate(client);
    if (!userId) {
      client.emit('unauthorized', { message: 'Not signed in' });
      client.disconnect(true);
      return null;
    }
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
