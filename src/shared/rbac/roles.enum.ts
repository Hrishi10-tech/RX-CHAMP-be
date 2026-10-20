/**
 * 4.0 roles (docs/4.0/SPEC.md section 1):
 *   SUPER_ADMIN  the platform: every organisation, acts inside one by selecting it
 *   ADMIN        one organisation: people, departments, settings (one per organisation)
 *   MANAGER      one organisation, one or more departments: read-only on people, approves
 *   USER         Staff: one organisation, one department, the agent only
 *
 * Scope is decided by organisation and department (shared/tenancy), not by
 * users.manager_id, which 4.0 no longer reads for access.
 */
export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  USER = 'USER',
}

export const ROLE_RANK: Record<Role, number> = {
  [Role.SUPER_ADMIN]: 4,
  [Role.ADMIN]: 3,
  [Role.MANAGER]: 2,
  [Role.USER]: 1,
};

/** Human labels for messages and notifications. */
export const ROLE_LABEL: Record<Role, string> = {
  [Role.SUPER_ADMIN]: 'Super Admin',
  [Role.ADMIN]: 'Admin',
  [Role.MANAGER]: 'Manager',
  [Role.USER]: 'Staff',
};

/** True when `actor` sits strictly above `target` in the hierarchy. */
export function outranks(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/**
 * Roles that may be given to an account by someone holding `actor` through the
 * people endpoints. An organisation's Admin is created only through
 * POST /organisations/:id/admin (Super Admin), never here.
 */
export function assignableRoles(actor: Role): Role[] {
  switch (actor) {
    case Role.SUPER_ADMIN:
    case Role.ADMIN:
      return [Role.MANAGER, Role.USER];
    default:
      return [];
  }
}

/** Admin or Super Admin: full control inside an organisation. */
export function isOrgAdmin(role: Role): boolean {
  return role === Role.ADMIN || role === Role.SUPER_ADMIN;
}

/** Roles that see other people's data (Team, reports, approvals). */
export const OVERSEER_ROLES: Role[] = [Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER];

/** Roles that administer an organisation. */
export const ORG_ADMIN_ROLES: Role[] = [Role.SUPER_ADMIN, Role.ADMIN];
