import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { managerRoom, userRoom } from '@shared/websocket/socket-rooms';
import { LiveActivityUpdate, MyActivityUpdate } from '../application/activity.types';

/**
 * Pushes live activity (active/idle status, the current app/website and the day's
 * active/idle totals) as each agent sample lands — so dashboards update without
 * polling. Mirrors {@link PresenceGateway}:
 *
 *  - Every client joins a personal room `user:<id>` and receives `activity:me`
 *    updates for their own dashboard (status + current app + running totals).
 *  - A manager additionally receives `activity:update` for each of their reports
 *    in their `manager:<id>` room (the live team board).
 */
@WebSocketGateway({
  namespace: '/activity',
  cors: { origin: true, credentials: true },
})
export class ActivityGateway extends AuthenticatedGateway implements OnGatewayConnection {
  protected readonly logger = new Logger(ActivityGateway.name);
  @WebSocketServer() protected server!: Server;

  constructor(jwt: JwtService, config: ConfigService) {
    super(jwt, config);
  }

  handleConnection(client: Socket): void {
    const userId = this.authenticateOrDisconnect(client);
    if (!userId) return;

    // Own dashboard updates, plus any team-board updates if this user manages reports.
    void client.join(userRoom(userId));
    void client.join(managerRoom(userId));
    this.logger.debug(`socket ${client.id} joined activity rooms for ${userId}`);
  }

  /** Push the user their own live status + current app + running totals. */
  emitToUser(userId: string, update: MyActivityUpdate): void {
    this.server.to(userRoom(userId)).emit('activity:me', update);
  }

  /** Push a manager one report's live status + current app + running totals. */
  emitToManager(managerId: string, update: LiveActivityUpdate): void {
    this.server.to(managerRoom(managerId)).emit('activity:update', update);
  }
}
