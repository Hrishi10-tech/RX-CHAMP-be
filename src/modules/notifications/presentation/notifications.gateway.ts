import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { userRoom } from '@shared/websocket/socket-rooms';
import { NotificationView } from '../application/notification.types';

@WebSocketGateway({
  namespace: '/notifications',
  cors: { origin: true, credentials: true },
})
export class NotificationsGateway extends AuthenticatedGateway implements OnGatewayConnection {
  protected readonly logger = new Logger(NotificationsGateway.name);
  @WebSocketServer() protected server!: Server;

  constructor(jwt: JwtService, config: ConfigService) {
    super(jwt, config);
  }

  handleConnection(client: Socket): void {
    const userId = this.authenticateOrDisconnect(client);
    if (!userId) return;

    void client.join(userRoom(userId));
    this.logger.debug(`socket ${client.id} joined ${userRoom(userId)}`);
  }

  emitToUser(userId: string, notification: NotificationView): void {
    this.server.to(userRoom(userId)).emit('notification', notification);
  }
}
