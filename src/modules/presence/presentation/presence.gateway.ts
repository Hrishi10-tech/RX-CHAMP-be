import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { SocketAccessService } from '@shared/websocket/socket-access.service';
import { socketCors } from '@shared/websocket/socket-cors';
import { managerRoom } from '@shared/websocket/socket-rooms';
import { TeamMemberPresenceView } from '../application/presence.types';

/**
 * Pushes live presence changes to managers. A manager's client connects and is
 * placed in a room keyed by their own user id; whenever one of their reports
 * switches status, the update is emitted to that room as `presence:update`.
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

    void client.join(managerRoom(userId));
    this.logger.debug(`socket ${client.id} joined ${managerRoom(userId)}`);
  }

  /** Notify a manager that one of their reports changed presence. */
  emitToManager(managerId: string, update: TeamMemberPresenceView): void {
    this.server.to(managerRoom(managerId)).emit('presence:update', update);
  }
}
