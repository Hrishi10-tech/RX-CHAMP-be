import { Inject, Injectable } from '@nestjs/common';
import { CHAT_REPOSITORY, ChatRepository } from '../../domain/chat.repository';
import { ChatGateway } from '../../presentation/chat.gateway';
import { SendMessageDto } from '../dto/send-message.dto';
import { ChatMapper } from '../chat.mapper';
import { ChatMessageView } from '../chat.types';

@Injectable()
export class SendMessageUseCase {
  constructor(
    @Inject(CHAT_REPOSITORY) private readonly repo: ChatRepository,
    private readonly gateway: ChatGateway,
  ) {}

  async execute(fromUserId: string, dto: SendMessageDto): Promise<ChatMessageView> {
    const saved = await this.repo.create({
      fromUserId,
      toUserId: dto.toUserId,
      body: dto.body,
    });

    this.gateway.emitToUser(dto.toUserId, ChatMapper.toMessageView(saved, dto.toUserId));
    this.gateway.emitToUser(fromUserId, ChatMapper.toMessageView(saved, fromUserId));

    return ChatMapper.toMessageView(saved, fromUserId);
  }
}
