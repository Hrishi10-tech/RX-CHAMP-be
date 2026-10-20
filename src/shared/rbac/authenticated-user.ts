import { UserStatus } from '@shared/types/user.types';
import { Permission } from './permissions.enum';
import { Role } from './roles.enum';

/** A manager's view grants (docs/4.0/SPEC.md 2.2). */
export interface ViewGrants {
  screenshots: boolean;
  timeline: boolean;
  activity: boolean;
}

export const NO_GRANTS: ViewGrants = Object.freeze({
  screenshots: false,
  timeline: false,
  activity: false,
});

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  permissions: Permission[];
  department: string | null;
  /** The organisation the person belongs to (null for a platform Super Admin). */
  companyId: string | null;
  status: UserStatus;
  /**
   * 4.0: the organisation this request acts in. Admin, Manager and Staff: their own.
   * Super Admin: the organisation chosen with the X-Org-Id header, or null.
   * Read it through orgOf()/requireOrg() in shared/tenancy, never directly.
   */
  orgId?: string | null;
  /** 4.0: X-Org-Id named an organisation that does not exist (Super Admin only). */
  orgHeaderInvalid?: boolean;
  /** 4.0: the person's organisation was deleted: they act in none (404 ORG_NOT_FOUND). */
  orgDeleted?: boolean;
  /** 4.0: the person's own department. */
  departmentId?: string | null;
  /** 4.0: departments a Manager is assigned to (empty for other roles). */
  managedDepartmentIds?: string[];
  /** 4.0: a Manager's view grants (Admin and Super Admin see everything). */
  grants?: ViewGrants;
}
