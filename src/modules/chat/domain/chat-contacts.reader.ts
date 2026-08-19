import { TeamMemberRef } from '@shared/types/user.types';

export const CHAT_CONTACTS_READER = Symbol('CHAT_CONTACTS_READER');

export interface ChatContact extends TeamMemberRef {
  role: string;
}

/** Just enough of a user to name them on a notification. */
export type ChatSender = Pick<TeamMemberRef, 'id' | 'firstName' | 'lastName'>;

export interface ChatContactsReader {
  findContacts(userId: string): Promise<ChatContact[]>;

  /** One user's name, for addressing a notification. `undefined` if not found. */
  findSender(userId: string): Promise<ChatSender | undefined>;
}
