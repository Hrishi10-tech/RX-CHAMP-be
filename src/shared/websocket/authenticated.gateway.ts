import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayInit } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { epochOf } from '@shared/security/token.service.port';
import { SocketHandshakeAuth, SocketIdentity, SocketTokenClaims } from './socket.types';
import { SocketAccessService, accountRoom } from './socket-access.service';
import { LiveSection, membersRoom } from './socket-rooms';

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

  protected authenticate(client: Socket): SocketIdentity | null {
    const token = this.tokenFrom(client);
    if (!token) return null;
    try {
      const claims = this.jwt.verify<SocketTokenClaims>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
      // An access token (no typ) or a socket ticket; never any other typed token.
      if (claims.typ !== undefined && claims.typ !== 'socket') return null;
      return claims.sub ? { userId: claims.sub, epoch: epochOf(claims) } : null;
    } catch {
      return null;
    }
  }

  /**
   * Admits a socket or disconnects it: allowed origin, valid token, an account
   * that is still active, and a token minted under the account's current auth
   * epoch (one from before a sign-out is refused however long it has left). On
   * success the socket joins its account room (used to drop it when the account is
   * blocked or signed out) and is checked again every access-token lifetime.
   */
  protected async authenticateOrDisconnect(client: Socket): Promise<string | null> {
    const origin = client.handshake.headers.origin;
    const who = this.access.originAllowed(origin) ? this.authenticate(client) : null;
    const account = who ? await this.access.admit(who.userId, who.epoch) : null;
    if (!who || !account) {
      client.emit('unauthorized', { message: 'Not signed in' });
      client.disconnect(true);
      return null;
    }
    // Gone while the account was being read: nothing to join or watch.
    if (client.disconnected) return null;
    client.data.role = account.role;
    await client.join(accountRoom(who.userId));
    this.access.watch(client, who.userId, who.epoch);
    return who.userId;
  }

  /** 4.0: joins the organisation and department rooms for this namespace's live data. */
  protected async joinTeamRooms(
    client: Socket,
    userId: string,
    section: LiveSection,
  ): Promise<void> {
    const rooms = await this.access.roomsFor(userId, this.orgHintOf(client), section);
    if (rooms.length) await client.join(rooms);
  }

  /**
   * 4.0: joins the organisation's members room (config pushes to agents and portal);
   * a Super Admin joins the organisation picked in the portal.
   */
  protected async joinMembersRoom(client: Socket, userId: string): Promise<void> {
    const companyId = await this.access.membersOrgOf(userId, this.orgHintOf(client));
    if (companyId) await client.join(membersRoom(companyId));
  }

  /** The organisation a Super Admin's portal names (auth.orgId, ?orgId or X-Org-Id). */
  private orgHintOf(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const fromAuth = typeof auth?.orgId === 'string' ? auth.orgId : null;
    const fromQuery =
      typeof client.handshake.query?.orgId === 'string' ? client.handshake.query.orgId : null;
    const header = client.handshake.headers['x-org-id'];
    const fromHeader = typeof header === 'string' ? header : null;
    return fromAuth ?? fromQuery ?? fromHeader;
  }

  /** 4.0: the rooms a live update about this person goes to. */
  protected roomsOfUser(userId: string): Promise<string[]> {
    return this.access.roomsOfUser(userId);
  }

  /**
   * 3.6 avatars: joins the rooms whose `avatar:changed` this account hears (the
   * people it is shown; SocketAccessService.avatarRooms). Never rejects.
   */
  protected async joinAvatarRooms(client: Socket, userId: string): Promise<void> {
    const rooms = await this.access.avatarRooms(userId, this.orgHintOf(client));
    if (rooms.length && !client.disconnected) await client.join(rooms);
  }

  /** 3.6 avatars: the rooms an `avatar:changed` about this person goes to, read now. */
  protected avatarAudience(userId: string): Promise<string[]> {
    return this.access.avatarAudience(userId);
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
