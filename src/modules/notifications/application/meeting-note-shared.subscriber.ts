import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { MeetingNoteSharedEvent } from '@modules/presence/domain/events/meeting-note-shared.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationMapper } from './notification.mapper';
import { NotificationsGateway } from '../presentation/notifications.gateway';
import { OversightRecipients } from './oversight-recipients.service';

/**
 * Turns an employee's meeting note into a persisted + realtime notification for
 * whoever oversees them (4.0: department managers, or the organisation's Admin).
 */
@Injectable()
export class MeetingNoteSharedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(MeetingNoteSharedSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
    private readonly recipients: OversightRecipients,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<MeetingNoteSharedEvent>(MeetingNoteSharedEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  private async handle(event: MeetingNoteSharedEvent): Promise<void> {
    const to = await this.recipients.of(event.fromUserId);
    for (const userId of to) {
      const saved = await this.notifications.create({
        userId,
        type: 'MEETING_NOTE',
        title: `${event.fromName} is in a meeting`,
        body: event.note,
        fromUserId: event.fromUserId,
      });
      this.gateway.emitToUser(userId, NotificationMapper.toView(saved));
    }
    this.logger.debug(`meeting note from ${event.fromUserId} -> ${to.length} recipient(s)`);
  }
}
