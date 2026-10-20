import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { fullName } from '@shared/types/user.types';
import { CHAT_REPOSITORY, ChatRepository } from '../../domain/chat.repository';
import { CHAT_CONTACTS_READER, ChatContactsReader } from '../../domain/chat-contacts.reader';
import { ChatMessageSentEvent } from '../../domain/events/chat-message-sent.event';
import { ChatGateway } from '../../presentation/chat.gateway';
import { SendMessageDto } from '../dto/send-message.dto';
import { ChatMapper } from '../chat.mapper';
import { ChatMessageView } from '../chat.types';

@Injectable()
export class SendMessageUseCase {
  private readonly logger = new Logger(SendMessageUseCase.name);

  constructor(
    @Inject(CHAT_REPOSITORY) private readonly repo: ChatRepository,
    @Inject(CHAT_CONTACTS_READER) private readonly contacts: ChatContactsReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly gateway: ChatGateway,
  ) {}

  async execute(me: AuthenticatedUser, dto: SendMessageDto): Promise<ChatMessageView> {
    const fromUserId = me.id;
    // Only your contacts (see the contacts reader, 4.0 rules). Without this, any
    // account could message any user id and raise a notification there.
    if (!(await this.contacts.canMessage(me, dto.toUserId))) {
      throw new ForbiddenError(
        'You can only message your own team, their managers and your organisation admin.',
      );
    }

    const saved = await this.repo.create({
      fromUserId,
      toUserId: dto.toUserId,
      body: dto.body,
    });

    this.gateway.emitToUser(dto.toUserId, ChatMapper.toMessageView(saved, dto.toUserId));
    this.gateway.emitToUser(fromUserId, ChatMapper.toMessageView(saved, fromUserId));

    await this.announce(saved.id, fromUserId, dto.toUserId, dto.body, saved.createdAt);

    return ChatMapper.toMessageView(saved, fromUserId);
  }

  /**
   * Raises the event that becomes the recipient's notification. The chat socket
   * above only reaches a client sitting on the chat screen, so without this a
   * recipient looking at any other page never learns a message arrived.
   *
   * Best-effort: the message is already saved and delivered, so a failure here
   * must not fail the send.
   */
  private async announce(
    messageId: string,
    fromUserId: string,
    toUserId: string,
    body: string,
    at: Date,
  ): Promise<void> {
    try {
      const sender = await this.contacts.findSender(fromUserId);
      await this.events.publish(
        ChatMessageSentEvent.eventName,
        new ChatMessageSentEvent(
          toUserId,
          fromUserId,
          sender ? fullName(sender) : 'Someone',
          messageId,
          body,
          at,
        ),
      );
    } catch (err) {
      this.logger.warn(
        `chat notification failed for message ${messageId}: ${(err as Error).message}`,
      );
    }
  }
}
