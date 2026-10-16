/**
 * Three tiers: Super Admin -> Manager -> Staff.
 *
 * The former ADMIN role was folded into MANAGER (migration
 * 20261013_shift_breaks_and_roles). Reporting lines still come from
 * users.manager_id: Super Admin creates Managers, Managers create Staff.
 */
export enum Role {
  SUPER_ADMIN = 'SUPER_ADMIN',
  MANAGER = 'MANAGER',
  USER = 'USER',
}

export const ROLE_RANK: Record<Role, number> = {
  [Role.SUPER_ADMIN]: 3,
  [Role.MANAGER]: 2,
  [Role.USER]: 1,
};

/** Human labels for messages and notifications. */
export const ROLE_LABEL: Record<Role, string> = {
  [Role.SUPER_ADMIN]: 'Super Admin',
  [Role.MANAGER]: 'Manager',
  [Role.USER]: 'Staff',
};

/** True when `actor` sits strictly above `target` in the hierarchy. */
export function outranks(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/** Roles that may be given to a new account by someone holding `actor`. */
export function assignableRoles(actor: Role): Role[] {
  switch (actor) {
    case Role.SUPER_ADMIN:
      return [Role.SUPER_ADMIN, Role.MANAGER, Role.USER];
    case Role.MANAGER:
      return [Role.USER];
    default:
      return [];
  }
}
