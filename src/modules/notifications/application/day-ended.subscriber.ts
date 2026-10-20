import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationMapper } from './notification.mapper';
import { NotificationsGateway } from '../presentation/notifications.gateway';
import { OversightRecipients } from './oversight-recipients.service';

/**
 * Tells whoever oversees a person (4.0: their department's managers, or the
 * organisation's Admin for a Manager), in the bell and in realtime, that they
 * ended their working day.
 */
@Injectable()
export class DayEndedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(DayEndedSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
    private readonly config: ConfigService,
    private readonly recipients: OversightRecipients,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<DayEndedEvent>(DayEndedEvent.eventName, (e) => this.handle(e));
  }

  private async handle(event: DayEndedEvent): Promise<void> {
    const to = await this.recipients.of(event.userId);
    // Nobody to tell: the day still ends, this is just the notice.
    if (!to.length) return;

    // Formatted in the business timezone, not the host's. Without an explicit zone
    // this used the server clock — UTC in production — so a sign-off at 6:38 PM IST
    // reached the manager as "1:08 PM", exactly 5h30m out.
    const at = event.endedAt.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: this.config.get<string>('timezone') ?? 'Asia/Kolkata',
    });

    for (const userId of to) {
      const saved = await this.notifications.create({
        userId,
        type: 'DAY_ENDED',
        title: `${event.userName} ended their working day`,
        body:
          `Signed off at ${at}. Activity tracking, screen captures and attendance have ` +
          `stopped for the rest of the day. Today's totals are final.`,
        fromUserId: event.userId,
      });
      this.gateway.emitToUser(userId, NotificationMapper.toView(saved));
    }
    this.logger.debug(`day ended by ${event.userId} -> ${to.length} recipient(s)`);
  }
}
