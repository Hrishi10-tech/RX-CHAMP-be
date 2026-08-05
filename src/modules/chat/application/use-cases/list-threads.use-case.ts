import { Inject, Injectable } from '@nestjs/common';
import { CHAT_CONTACTS_READER, ChatContactsReader } from '../../domain/chat-contacts.reader';
import { CHAT_REPOSITORY, ChatRepository } from '../../domain/chat.repository';
import { ChatMapper } from '../chat.mapper';
import { ChatThreadView } from '../chat.types';


@Injectable()
export class ListThreadsUseCase {
  constructor(
    @Inject(CHAT_CONTACTS_READER) private readonly contacts: ChatContactsReader,
    @Inject(CHAT_REPOSITORY) private readonly repo: ChatRepository,
  ) {}

  async execute(meId: string): Promise<ChatThreadView[]> {
    const contacts = await this.contacts.findContacts(meId);
    const summaries = await this.repo.threadSummaries(
      meId,
      contacts.map((c) => c.id),
    );
    const byId = new Map(summaries.map((s) => [s.otherId, s]));

    const threads = contacts.map((c) => ChatMapper.toThreadView(c, byId.get(c.id), meId));

    // Most recent conversation first; contacts with no messages fall to the bottom.
    return threads.sort((a, b) => {
      const ta = a.lastMessage ? Date.parse(a.lastMessage.createdAt) : 0;
      const tb = b.lastMessage ? Date.parse(b.lastMessage.createdAt) : 0;
      return tb - ta;
    });
  }
}
