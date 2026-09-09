import { BulkError } from '@shared/types/common.types';
import { PaginatedResult } from '@shared/types/pagination.types';
import { UserStatus } from '@shared/types/user.types';

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: string;
  department: string | null;
  designation: string | null;
  managerId: string | null;
  companyId: string | null;
  shiftId: string | null;
  shiftStart: string | null;
  shiftEnd: string | null;
  status: UserStatus;
  /** Whether the agent takes automatic screenshots for this user. */
  screenshotsEnabled: boolean;
  createdAt: string;
}

/**
 * Whether this person's agent is set up and recording — distinct from `status`,
 * which is only whether the account may sign in.
 *
 * Each value exists because it calls for a different response:
 *   LIVE          reporting now — nothing to do.
 *   DAY_ENDED     they ended their day; silence is expected, not a fault. Without
 *                 this every properly finished day looked like a broken agent by
 *                 evening, which made the whole column easy to ignore.
 *   NOT_SIGNED_IN they hold no usable session — signed out, or it broke on its own.
 *                 They must sign in again. This is the case that spent a week
 *                 looking like plain OFFLINE while nobody was being tracked.
 *   OFFLINE       signed in and expected to be working, but nothing is arriving:
 *                 asleep, closed, or genuinely broken. The one worth chasing.
 *   NOT_ACTIVATED never enrolled anywhere. One-way — uninstalling reads as OFFLINE,
 *                 because deleting the agent's files tells the server nothing.
 */
export type AgentStatus = 'LIVE' | 'DAY_ENDED' | 'OFFLINE' | 'NOT_SIGNED_IN' | 'NOT_ACTIVATED';

export interface UserListItem {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  role: string;
  department: string | null;
  company: string | null;
  status: UserStatus;
  /** Drives the screenshots toggle on each row of the members table. */
  screenshotsEnabled: boolean;
  /** Drives the Status column. */
  agentStatus: AgentStatus;
  /** Last activity report, so a row can say how long it has been quiet. */
  agentLastSeenAt: string | null;
  createdAt: string;
}

export type ListUsersResult = PaginatedResult<'users', UserListItem>;

export interface CreateUsersResult {
  created: PublicUser[];
  errors: BulkError<'email'>[];
}

export interface DeleteUserResult {
  deleted: true;
  id: string;
}
