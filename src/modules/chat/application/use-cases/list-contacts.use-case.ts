import { Inject, Injectable } from '@nestjs/common';
import { CHAT_CONTACTS_READER, ChatContactsReader } from '../../domain/chat-contacts.reader';
import { ChatMapper } from '../chat.mapper';
import { ChatContactView } from '../chat.types';

@Injectable()
export class ListContactsUseCase {
  constructor(@Inject(CHAT_CONTACTS_READER) private readonly contacts: ChatContactsReader) {}

  async execute(userId: string): Promise<ChatContactView[]> {
    const rows = await this.contacts.findContacts(userId);
    return rows.map(ChatMapper.toContactView);
  }
}
