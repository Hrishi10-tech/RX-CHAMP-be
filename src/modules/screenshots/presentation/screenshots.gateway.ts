import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { userRoom } from '@shared/websocket/socket-rooms';

/**
 * Command channel to the desktop agent. Each agent connects and joins a room
 * keyed by its user id; a manager's "capture now" request emits `screenshot:capture`
 * into that room, and the agent responds by grabbing the screen and uploading it.
 */
@WebSocketGateway({
  namespace: '/screenshots',
  cors: { origin: true, credentials: true },
})
export class ScreenshotsGateway extends AuthenticatedGateway implements OnGatewayConnection {
  protected readonly logger = new Logger(ScreenshotsGateway.name);
  @WebSocketServer() protected server!: Server;

  constructor(jwt: JwtService, config: ConfigService) {
    super(jwt, config);
  }

  handleConnection(client: Socket): void {
    const userId = this.authenticateOrDisconnect(client);
    if (!userId) return;

    void client.join(userRoom(userId));
    this.logger.debug(`agent socket ${client.id} joined ${userRoom(userId)}`);
  }

  /** Ask a user's agent to capture a screenshot immediately. */
  emitCaptureRequest(userId: string): void {
    this.server.to(userRoom(userId)).emit('screenshot:capture', { at: new Date().toISOString() });
  }
}
