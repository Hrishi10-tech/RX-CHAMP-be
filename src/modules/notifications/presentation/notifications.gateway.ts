import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AuthenticatedGateway } from '@shared/websocket/authenticated.gateway';
import { SocketAccessService } from '@shared/websocket/socket-access.service';
import { socketCors } from '@shared/websocket/socket-cors';
import { membersRoom, userRoom } from '@shared/websocket/socket-rooms';
import { ApprovalAction, ApprovalWhat } from '@shared/events/approval-changed.event';
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
    await this.joinAvatarRooms(client, userId);
    this.logger.debug(`socket ${client.id} joined ${userRoom(userId)}`);
  }

  /** 4.0: tell every socket of an organisation that its configuration changed. */
  emitConfigChanged(companyId: string, kind: string, at: Date): void {
    this.server.to(membersRoom(companyId)).emit('config:changed', { kind, at: at.toISOString() });
  }

  /** 4.0: tell one person's sockets that their working day changed (a decision, a replay). */
  /**
   * `workday:changed` to the person's devices. 4.0 agents read `reason`; the 3.4+
   * phone app reads `what`: both carry the same value.
   */
  emitWorkdayChanged(userId: string, reason: string, at = new Date().toISOString()): void {
    this.server?.to(userRoom(userId)).emit('workday:changed', { reason, what: reason, at });
  }

  emitToUser(userId: string, notification: NotificationView): void {
    this.server.to(userRoom(userId)).emit('notification', notification);
  }

  /**
   * An approval item changed (3.6): these people's devices refresh. `needsYou` marks
   * those it is waiting on, so a phone can tell a new request of theirs from the rest.
   * Sent to each person's own room only, so it never reaches another organisation.
   */
  emitApprovals(
    userIds: string[],
    change: {
      what: ApprovalWhat;
      id: string;
      action: ApprovalAction;
      needsYou: boolean;
      at: string;
    },
  ): void {
    if (!userIds.length) return;
    this.server?.to(userIds.map(userRoom)).emit('approvals:changed', change);
  }

  /**
   * The person's avatar changed (3.6): their devices and the people shown them update
   * within seconds. 4.0 audience (avatarRoomsOf), read when sent: the organisation's
   * admins and the platform roles with it in view, the department's managers (of
   * Staff), the Staff of the departments they manage (of a Manager), everyone in the
   * organisation (of an Admin); never another organisation.
   */
  async emitAvatar(userId: string, avatarId: string | null): Promise<void> {
    const rooms = await this.avatarAudience(userId);
    this.server?.to(rooms).emit('avatar:changed', { userId, avatarId });
  }
}
