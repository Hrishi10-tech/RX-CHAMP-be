import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { AgentActivatedEvent } from '@modules/auth/domain/events/agent-activated.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationMapper } from './notification.mapper';
import { NotificationsGateway } from '../presentation/notifications.gateway';
import { OversightRecipients } from './oversight-recipients.service';

/**
 * Turns a first-time agent activation into a persisted + realtime notification for
 * whoever oversees the person (4.0: department managers, or the organisation's Admin).
 */
@Injectable()
export class AgentActivatedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(AgentActivatedSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
    private readonly recipients: OversightRecipients,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<AgentActivatedEvent>(AgentActivatedEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  private async handle(event: AgentActivatedEvent): Promise<void> {
    const to = await this.recipients.of(event.userId);
    for (const userId of to) {
      const saved = await this.notifications.create({
        userId,
        type: 'AGENT_ACTIVATED',
        title: `${event.userName} activated RX Vision`,
        body: 'Their device is now set up — attendance, activity and screen monitoring are active.',
        fromUserId: event.userId,
      });
      this.gateway.emitToUser(userId, NotificationMapper.toView(saved));
    }
    this.logger.debug(`agent activated by ${event.userId} -> ${to.length} recipient(s)`);
  }
}
