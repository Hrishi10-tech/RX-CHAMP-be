import { TeamMemberRef } from '@shared/types/user.types';

export const CHAT_CONTACTS_READER = Symbol('CHAT_CONTACTS_READER');

export interface ChatContact extends TeamMemberRef {
  role: string;
}

export interface ChatContactsReader {
  findContacts(userId: string): Promise<ChatContact[]>;
}
