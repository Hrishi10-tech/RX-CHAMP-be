import { TeamMemberRef } from '@shared/types/user.types';

export const PRESENCE_TEAM_READER = Symbol('PRESENCE_TEAM_READER');

export type TeamMember = TeamMemberRef;

export interface PresenceContext {
  /** The user themselves (for building live-update payloads). */
  self: TeamMember;
  /** Who they report to, or null. Used to route live updates + meeting notes. */
  managerId: string | null;
}

/**
 * Reads the manager → reports relationship for presence views. Kept as a
 * dedicated port so the presence module doesn't reach into the users/companies
 * modules directly.
 */
export interface PresenceTeamReader {
  /** Active users who report to the given manager. */
  findReports(managerId: string): Promise<TeamMember[]>;

  /** The user's own profile + their manager id, or null if the user doesn't exist. */
  findContext(userId: string): Promise<PresenceContext | null>;
}
