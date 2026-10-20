import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { SocketAccessService } from '@shared/websocket/socket-access.service';
import { socketCors } from '@shared/websocket/socket-cors';
import { TeamMemberPresenceView } from '../application/presence.types';

/**
 * Pushes live presence changes to the people who oversee them (4.0): the
 * organisation's admins and, for Staff, the managers of their department. A
 * portal client joins those rooms when it connects (docs/4.0/SPEC.md 1.4).
 */
@WebSocketGateway({
  namespace: '/presence',
  cors: socketCors(),
})
export class PresenceGateway extends AuthenticatedGateway implements OnGatewayConnection {
  protected readonly logger = new Logger(PresenceGateway.name);
  @WebSocketServer() protected server!: Namespace;

  constructor(jwt: JwtService, config: ConfigService, access: SocketAccessService) {
    super(jwt, config, access);
  }

  async handleConnection(client: Socket): Promise<void> {
    const userId = await this.authenticateOrDisconnect(client);
    if (!userId) return;

    await this.joinTeamRooms(client, userId, 'presence');
  }

  /** Tell everyone who oversees `subjectId` that their presence changed. */
  async emitForSubject(subjectId: string, update: TeamMemberPresenceView): Promise<void> {
    const rooms = await this.roomsOfUser(subjectId);
    if (rooms.length) this.server.to(rooms).emit('presence:update', update);
  }
}
