/**
 * Callers for scope-matrix tests (not a test itself, and not part of the build:
 * the name ends in "spec.ts" without matching jest's ".spec.ts").
 */
import { AuthenticatedUser, NO_GRANTS, ViewGrants } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';

export const ORG_A = '00000000-0000-0000-0000-0000000000a0';
export const ORG_B = '00000000-0000-0000-0000-0000000000b0';
export const DEPT_A1 = '00000000-0000-0000-0000-0000000000a1';
export const DEPT_A2 = '00000000-0000-0000-0000-0000000000a2';
export const DEPT_B1 = '00000000-0000-0000-0000-0000000000b1';

export const IDS = {
  superAdmin: '10000000-0000-0000-0000-000000000001',
  adminA: '10000000-0000-0000-0000-0000000000a1',
  adminB: '10000000-0000-0000-0000-0000000000b1',
  managerA1: '20000000-0000-0000-0000-0000000000a1',
  managerNoDept: '20000000-0000-0000-0000-0000000000a9',
  managerB1: '20000000-0000-0000-0000-0000000000b1',
  staffA1: '30000000-0000-0000-0000-0000000000a1',
  staffA2: '30000000-0000-0000-0000-0000000000a2',
  staffB1: '30000000-0000-0000-0000-0000000000b1',
} as const;

function base(id: string, role: Role, companyId: string | null): AuthenticatedUser {
  return {
    id,
    email: `${id.slice(-4)}@test.local`,
    role,
    permissions: [],
    department: null,
    companyId,
    status: 'ACTIVE',
    orgId: role === Role.SUPER_ADMIN ? null : companyId,
    departmentId: null,
    managedDepartmentIds: [],
  };
}

/** A Super Admin acting in `orgId` (X-Org-Id), or on the platform view when omitted. */
export function superAdmin(orgId: string | null = null): AuthenticatedUser {
  return { ...base(IDS.superAdmin, Role.SUPER_ADMIN, null), orgId };
}

export function admin(org: string = ORG_A): AuthenticatedUser {
  return base(org === ORG_A ? IDS.adminA : IDS.adminB, Role.ADMIN, org);
}

export function manager(
  depts: string[] = [DEPT_A1],
  grants: Partial<ViewGrants> = {},
  org: string = ORG_A,
): AuthenticatedUser {
  const id = depts.length === 0 ? IDS.managerNoDept : org === ORG_A ? IDS.managerA1 : IDS.managerB1;
  return {
    ...base(id, Role.MANAGER, org),
    departmentId: depts[0] ?? null,
    managedDepartmentIds: depts,
    grants: { ...NO_GRANTS, ...grants },
  };
}

export function staff(dept: string = DEPT_A1, org: string = ORG_A): AuthenticatedUser {
  const id = org === ORG_B ? IDS.staffB1 : dept === DEPT_A2 ? IDS.staffA2 : IDS.staffA1;
  return { ...base(id, Role.USER, org), departmentId: dept };
}
