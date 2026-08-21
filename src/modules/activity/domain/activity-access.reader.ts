import { ManagerLookupReader } from '@shared/rbac/manager-lookup.reader';
import { TeamMemberRef, TeamMemberWithManager } from '@shared/types/user.types';

export const ACTIVITY_ACCESS_READER = Symbol('ACTIVITY_ACCESS_READER');

export type ActivityTeamMember = TeamMemberRef;

/**
 * A user's own profile plus who they report to — for building live pushes — and
 * whether their automatic screenshots are switched on, which the agent is told on
 * every report.
 */
export type ActivitySelf = TeamMemberWithManager & { screenshotsEnabled: boolean };

/**
 * The manager → reports relationship the activity module needs to decide who may
 * view a user's activity, without reaching into the users module directly.
 */
export interface ActivityAccessReader extends ManagerLookupReader {
  /** Active users who report to the given manager. */
  findReports(managerId: string): Promise<ActivityTeamMember[]>;

  /** The user's own profile + managerId (one query), `undefined` if not found. */
  findSelf(userId: string): Promise<ActivitySelf | undefined>;
}
