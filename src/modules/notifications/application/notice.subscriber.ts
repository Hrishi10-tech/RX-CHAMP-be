import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationsGateway } from '../presentation/notifications.gateway';
import { NotificationMapper } from './notification.mapper';

/**
 * Stores and pushes a ready-written notice (the 3.1 types: skips, meetings, the
 * 48-hour rule, monthly reports, auto-closed days) to each recipient once.
 */
@Injectable()
export class NoticeSubscriber implements OnModuleInit {
  private readonly logger = new Logger(NoticeSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<NoticeEvent>(NoticeEvent.eventName, (e) => this.handle(e));
  }

  async handle(e: NoticeEvent): Promise<void> {
    for (const userId of new Set(e.recipientIds)) {
      if (e.fromUserId && userId === e.fromUserId) continue;
      try {
        const saved = await this.notifications.create({
          userId,
          type: e.type,
          title: e.title,
          body: e.body,
          fromUserId: e.fromUserId,
        });
        this.gateway.emitToUser(userId, NotificationMapper.toView(saved));
      } catch (err) {
        this.logger.warn(`${e.type} for ${userId} failed: ${(err as Error).message}`);
      }
    }
  }
}
