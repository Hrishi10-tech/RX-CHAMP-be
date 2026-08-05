import { Inject, Injectable } from '@nestjs/common';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../../domain/notification.repository';
import { NotificationMapper } from '../notification.mapper';
import { ListNotificationsResult } from '../notification.types';
import { ListNotificationsQueryDto } from '../dto';

@Injectable()
export class ListNotificationsUseCase {
  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository,
  ) {}

  async execute(
    userId: string,
    query: ListNotificationsQueryDto = {},
  ): Promise<ListNotificationsResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [list, total, unread] = await Promise.all([
      this.repo.listForUser(userId, {
        unreadOnly: query.unreadOnly,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.repo.countForUser(userId, { unreadOnly: query.unreadOnly }),
      this.repo.countForUser(userId, { unreadOnly: true }),
    ]);

    return { notifications: list.map(NotificationMapper.toView), total, unread, page, limit };
  }
}
