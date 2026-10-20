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
  /** 4.0: the department (`department` stays its name, which 3.x agents read). */
  departmentId: string | null;
  departmentRef: DepartmentRefView | null;
  /** 4.0: a Manager's departments (empty for other roles). */
  departments: DepartmentRefView[];
  /** 4.0: a Manager's view grants (all false for other roles). */
  grants: { screenshots: boolean; timeline: boolean; activity: boolean };
  /** 4.0: the person's input-tracking override (null = the department's setting). */
  idle: { enabled: boolean | null; minutes: number | null };
  /** 4.0: the same override, flat (what the portal reads). */
  idleEnabled: boolean | null;
  idleMinutes: number | null;
}

export interface DepartmentRefView {
  id: string;
  name: string;
  icon: string;
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
  /** 4.0 (Admin view). */
  designation: string | null;
  departmentId: string | null;
  departmentRef: DepartmentRefView | null;
  departments: DepartmentRefView[];
  grants: { screenshots: boolean; timeline: boolean; activity: boolean };
  idle: { enabled: boolean | null; minutes: number | null };
  idleEnabled: boolean | null;
  idleMinutes: number | null;
  companyId: string | null;
  shiftId: string | null;
}

/** 4.0: what a Manager (their departments' Staff) or Staff (themselves) sees in GET /users. */
export interface UserBriefItem {
  id: string;
  name: string;
  email: string;
  designation: string | null;
  /** The department's name. */
  department: string | null;
  departmentRef: DepartmentRefView | null;
}

export type ListUsersResult = PaginatedResult<'users', UserListItem | UserBriefItem>;

/** GET /me (docs/4.0/SPEC.md 5.3): who is signed in and what the portal may show them. */
export interface MeView {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  /** The organisation acted in: own, or the Super Admin's selection (X-Org-Id); null on the platform view. */
  organisation: { id: string; name: string } | null;
  department: DepartmentRefView | null;
  /** A Manager's departments. */
  departments: DepartmentRefView[];
  grants: { screenshots: boolean; timeline: boolean; activity: boolean };
  permissions: MePermissions;
}

/** Booleans the portal renders menus from (docs/4.0/SPEC.md 1.2, 7.1). */
export interface MePermissions {
  /** Organisations, platform overview (Super Admin). */
  canManageOrganisations: boolean;
  /** Settings, calendar edits, input tracking, sign-out keys, shifts (Admin; Super Admin with an organisation). */
  canManageOrg: boolean;
  /** Team management: add, edit, block, delete people; credentials. */
  canManagePeople: boolean;
  canManageDepartments: boolean;
  canManageShifts: boolean;
  /** Team page and productivity dashboard. */
  canSeeTeam: boolean;
  canSeeScreenshots: boolean;
  canSeeTimeline: boolean;
  canSeeActivity: boolean;
  canApprove: boolean;
  canSeeReports: boolean;
  canSeeTeamBreaks: boolean;
  canUseMessages: boolean;
  /** Staff use the agent only. */
  canUsePortal: boolean;
  /** A Super Admin on the platform view must pick an organisation for org pages. */
  needsOrganisation: boolean;
}

export interface CreateUsersResult {
  created: PublicUser[];
  errors: BulkError<'email'>[];
}

export interface DeleteUserResult {
  deleted: true;
  id: string;
}
