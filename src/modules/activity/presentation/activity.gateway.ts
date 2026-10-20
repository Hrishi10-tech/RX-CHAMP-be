import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { SocketAccessService } from '@shared/websocket/socket-access.service';
import { socketCors } from '@shared/websocket/socket-cors';
import { activityViewRoom, userRoom } from '@shared/websocket/socket-rooms';
import { LiveActivityUpdate, MyActivityUpdate } from '../application/activity.types';
import { liveUpdateFor } from '../application/activity-redaction';

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
  cors: socketCors(),
})
export class ActivityGateway extends AuthenticatedGateway implements OnGatewayConnection {
  protected readonly logger = new Logger(ActivityGateway.name);
  @WebSocketServer() protected server!: Namespace;

  constructor(jwt: JwtService, config: ConfigService, access: SocketAccessService) {
    super(jwt, config, access);
  }

  async handleConnection(client: Socket): Promise<void> {
    const userId = await this.authenticateOrDisconnect(client);
    if (!userId) return;

    // Own dashboard updates, plus the team rooms this person may watch (4.0: admins
    // their organisation, managers their departments with the timeline or activity
    // grant, each getting only the part of the push their grants allow).
    void client.join(userRoom(userId));
    await this.joinTeamRooms(client, userId, 'activity');
  }

  /** Push the user their own live status + current app + running totals. */
  emitToUser(userId: string, update: MyActivityUpdate): void {
    this.server.to(userRoom(userId)).emit('activity:me', update);
  }

  /**
   * Push one person's live status + current app + running totals to whoever
   * oversees them (4.0): the organisation's admins and the department's managers
   * with both grants get all of it; a manager with only the timeline grant gets it
   * without active and idle time, one with only the activity grant without the
   * app, title, URL and top apps.
   */
  async emitForSubject(subjectId: string, update: LiveActivityUpdate): Promise<void> {
    const rooms = await this.roomsOfUser(subjectId);
    if (!rooms.length) return;
    this.server.to(rooms).emit('activity:update', update);
    const depts = rooms.filter((r) => r.startsWith('dept:'));
    for (const view of ['timeline', 'activity'] as const) {
      if (!depts.length) break;
      this.server
        .to(depts.map((r) => activityViewRoom(r, view)))
        .emit('activity:update', liveUpdateFor(update, view));
    }
  }
}
