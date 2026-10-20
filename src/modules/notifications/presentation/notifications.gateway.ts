import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { SocketAccessService } from '@shared/websocket/socket-access.service';
import { socketCors } from '@shared/websocket/socket-cors';
import { membersRoom, userRoom } from '@shared/websocket/socket-rooms';
import { NotificationView } from '../application/notification.types';

@WebSocketGateway({
  namespace: '/notifications',
  cors: socketCors(),
})
export class NotificationsGateway extends AuthenticatedGateway implements OnGatewayConnection {
  protected readonly logger = new Logger(NotificationsGateway.name);
  @WebSocketServer() protected server!: Namespace;

  constructor(jwt: JwtService, config: ConfigService, access: SocketAccessService) {
    super(jwt, config, access);
  }

  async handleConnection(client: Socket): Promise<void> {
    const userId = await this.authenticateOrDisconnect(client);
    if (!userId) return;

    void client.join(userRoom(userId));
    await this.joinMembersRoom(client, userId);
    this.logger.debug(`socket ${client.id} joined ${userRoom(userId)}`);
  }

  /** 4.0: tell every socket of an organisation that its configuration changed. */
  emitConfigChanged(companyId: string, kind: string, at: Date): void {
    this.server.to(membersRoom(companyId)).emit('config:changed', { kind, at: at.toISOString() });
  }

  /** 4.0: tell one person's sockets that their working day changed (a decision, a replay). */
  emitWorkdayChanged(userId: string, reason: string): void {
    this.server
      .to(userRoom(userId))
      .emit('workday:changed', { reason, at: new Date().toISOString() });
  }

  emitToUser(userId: string, notification: NotificationView): void {
    this.server.to(userRoom(userId)).emit('notification', notification);
  }
}
