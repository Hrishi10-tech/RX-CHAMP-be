import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationMapper } from './notification.mapper';
import { NotificationsGateway } from '../presentation/notifications.gateway';

/** Tells a manager, in the bell and in realtime, that one of their reports signed off. */
@Injectable()
export class DayEndedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(DayEndedSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<DayEndedEvent>(DayEndedEvent.eventName, (e) => this.handle(e));
  }

  private async handle(event: DayEndedEvent): Promise<void> {
    // No manager, nobody to tell — the day still ends, this is just the notice.
    if (!event.managerId) return;

    // Formatted in the business timezone, not the host's. Without an explicit zone
    // this used the server clock — UTC in production — so a sign-off at 6:38 PM IST
    // reached the manager as "1:08 PM", exactly 5h30m out.
    const at = event.endedAt.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: this.config.get<string>('timezone') ?? 'Asia/Kolkata',
    });

    const saved = await this.notifications.create({
      userId: event.managerId,
      type: 'DAY_ENDED',
      title: `${event.userName} ended their working day`,
      body:
        `Signed off at ${at}. Activity tracking, screen captures and attendance have ` +
        `stopped for the rest of the day — today's totals are final.`,
    });

    this.gateway.emitToUser(event.managerId, NotificationMapper.toView(saved));
    this.logger.debug(`day ended by ${event.userId} → manager ${event.managerId}`);
  }
}
