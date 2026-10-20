import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { TeamMemberRef } from '@shared/types/user.types';

export const CHAT_CONTACTS_READER = Symbol('CHAT_CONTACTS_READER');

/**
 * How a contact relates to the person asking (4.0): MANAGER = someone above them
 * (Staff: their department's managers; a Manager: the Admin; an Admin: the Super
 * Admins), REPORT = someone they oversee, ORG = anyone else they may message.
 */
export type ChatRelation = 'MANAGER' | 'REPORT' | 'ORG';

export interface ChatContact extends TeamMemberRef {
  role: string;
  relation: ChatRelation;
}

/** Just enough of a user to name them on a notification. */
export type ChatSender = Pick<TeamMemberRef, 'id' | 'firstName' | 'lastName'>;

export interface ChatContactsReader {
  /** Who the caller may message (docs/4.0/SPEC.md 1.2, Messages). */
  findContacts(me: AuthenticatedUser): Promise<ChatContact[]>;

  /** Whether the caller may message `toUserId` (the recipient is in their contacts). */
  canMessage(me: AuthenticatedUser, toUserId: string): Promise<boolean>;

  /** One user's name, for addressing a notification. `undefined` if not found. */
  findSender(userId: string): Promise<ChatSender | undefined>;
}
