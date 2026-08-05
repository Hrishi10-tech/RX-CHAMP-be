import { Inject, Injectable } from '@nestjs/common';
import { CHAT_REPOSITORY, ChatRepository } from '../../domain/chat.repository';

@Injectable()
export class GetUnreadCountUseCase {
  constructor(@Inject(CHAT_REPOSITORY) private readonly repo: ChatRepository) {}

  async execute(meId: string): Promise<{ count: number }> {
    return { count: await this.repo.countUnread(meId) };
  }
}
