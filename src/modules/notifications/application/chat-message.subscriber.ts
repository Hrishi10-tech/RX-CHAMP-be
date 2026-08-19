import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { ChatMessageSentEvent } from '@modules/chat/domain/events/chat-message-sent.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationMapper } from './notification.mapper';
import { NotificationsGateway } from '../presentation/notifications.gateway';

/** How much of the message body a toast carries; the rest is in the chat itself. */
const PREVIEW_MAX = 140;

/**
 * Turns an incoming chat message into a persisted notification + realtime push for
 * the recipient. The chat namespace only reaches clients with the conversation
 * open, so this is what lets a toast appear on any other screen — and it keeps the
 * bell badge correct for a recipient who was offline when the message landed.
 */
@Injectable()
export class ChatMessageSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ChatMessageSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<ChatMessageSentEvent>(ChatMessageSentEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  private async handle(event: ChatMessageSentEvent): Promise<void> {
    const saved = await this.notifications.create({
      userId: event.toUserId,
      type: 'CHAT_MESSAGE',
      title: `New message from ${event.fromName}`,
      body: this.preview(event.body),
      // Lets the client open that person's conversation from the toast.
      fromUserId: event.fromUserId,
    });

    this.gateway.emitToUser(event.toUserId, NotificationMapper.toView(saved));
    this.logger.debug(`chat message from ${event.fromUserId} → ${event.toUserId}`);
  }

  private preview(body: string): string {
    const text = body.trim();
    return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX - 1)}…` : text;
  }
}
