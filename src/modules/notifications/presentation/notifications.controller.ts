import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ListNotificationsQueryDto } from '../application/dto/list-notifications-query.dto';
import { ListNotificationsUseCase } from '../application/use-cases/list-notifications.use-case';
import {
  CountUnreadNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  MarkNotificationReadUseCase,
} from '../application/use-cases/mark-notification-read.use-case';

@ApiTags('notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly listNotifications: ListNotificationsUseCase,
    private readonly markRead: MarkNotificationReadUseCase,
    private readonly markAllRead: MarkAllNotificationsReadUseCase,
    private readonly countUnread: CountUnreadNotificationsUseCase,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the signed-in user's notifications (paginated)" })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() query: ListNotificationsQueryDto) {
    const { notifications, total, unread, page, limit } = await this.listNotifications.execute(
      me.id,
      query,
    );
    const totalPages = Math.ceil(total / limit);
    return envelope(notifications, { meta: { total, unread, page, limit, totalPages } });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Number of unread notifications (for the bell badge)' })
  async unreadCount(@CurrentUser() me: AuthenticatedUser) {
    const unread = await this.countUnread.execute(me.id);
    return envelope({ unread });
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark one notification as read' })
  async read(@CurrentUser() me: AuthenticatedUser, @Param('id') id: string) {
    return envelope(await this.markRead.execute(me.id, id));
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async readAll(@CurrentUser() me: AuthenticatedUser) {
    const updated = await this.markAllRead.execute(me.id);
    return envelope({ updated });
  }
}
