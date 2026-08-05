import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { userRoom } from '@shared/websocket/socket-rooms';
import { ChatMessageView } from '../application/chat.types';

/**
 * Realtime chat delivery. Each client joins a room keyed by its user id; a new
 * message is emitted as `chat:message` to the recipient's room.
 */
@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: true, credentials: true },
})
export class ChatGateway extends AuthenticatedGateway implements OnGatewayConnection {
  protected readonly logger = new Logger(ChatGateway.name);
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

  /** Deliver a message to its recipient in realtime. */
  emitToUser(userId: string, message: ChatMessageView): void {
    this.server.to(userRoom(userId)).emit('chat:message', message);
  }
}
