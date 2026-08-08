import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@shared/exceptions/app.exception';
import {
  NOTIFICATION_REPOSITORY,
  NotificationRepository,
} from '../../domain/notification.repository';
import { NotificationMapper } from '../notification.mapper';
import { NotificationView } from '../notification.types';

@Injectable()
export class MarkNotificationReadUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository) {}
  async execute(userId: string, id: string): Promise<NotificationView> {
    const updated = await this.repo.markRead(userId, id);
    if (!updated) throw new NotFoundError('Unknown notification');
    return NotificationMapper.toView(updated);
  }
}

@Injectable()
export class MarkAllNotificationsReadUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository) {}

  /** Mark every unread notification for the user read; returns how many changed. */
  async execute(userId: string): Promise<number> {
    return this.repo.markAllRead(userId);
  }
}

@Injectable()
export class CountUnreadNotificationsUseCase {
  constructor(@Inject(NOTIFICATION_REPOSITORY) private readonly repo: NotificationRepository) {}

  async execute(userId: string): Promise<number> {
    return this.repo.countForUser(userId, { unreadOnly: true });
  }
}
