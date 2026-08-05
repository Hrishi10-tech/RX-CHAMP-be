import { Inject, Injectable } from '@nestjs/common';
import { CHAT_REPOSITORY, ChatRepository } from '../../domain/chat.repository';
import { ConversationQueryDto } from '../dto/conversation-query.dto';
import { ChatMapper } from '../chat.mapper';
import { ChatMessageView } from '../chat.types';

@Injectable()
export class GetConversationUseCase {
  constructor(@Inject(CHAT_REPOSITORY) private readonly repo: ChatRepository) {}

  async execute(meId: string, query: ConversationQueryDto): Promise<ChatMessageView[]> {
    const messages = await this.repo.listConversation(meId, query.withUserId, query.limit ?? 50);
    // Opening a conversation marks the other side's messages read.
    await this.repo.markRead(meId, query.withUserId);
    return messages.map((m) => ChatMapper.toMessageView(m, meId));
  }
}
