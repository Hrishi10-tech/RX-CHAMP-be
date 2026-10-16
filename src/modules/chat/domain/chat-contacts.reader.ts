import { TeamMemberRef } from '@shared/types/user.types';

export const CHAT_CONTACTS_READER = Symbol('CHAT_CONTACTS_READER');

/** How a contact relates to the person asking: their own manager, one of their
 *  reports, or (for a Super Admin) any manager in the organisation. */
export type ChatRelation = 'MANAGER' | 'REPORT' | 'ORG';

export interface ChatContact extends TeamMemberRef {
  role: string;
  relation: ChatRelation;
}

/** Just enough of a user to name them on a notification. */
export type ChatSender = Pick<TeamMemberRef, 'id' | 'firstName' | 'lastName'>;

export interface ChatContactsReader {
  findContacts(userId: string): Promise<ChatContact[]>;

  /** Whether `fromUserId` may message `toUserId` (the recipient is in their contacts). */
  canMessage(fromUserId: string, toUserId: string): Promise<boolean>;

  /** One user's name, for addressing a notification. `undefined` if not found. */
  findSender(userId: string): Promise<ChatSender | undefined>;
}
