import { Role, assignableRoles, seesEveryOrg } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import {
  assertCanEdit,
  canEditPerson,
  canSeePerson,
  managedDeptIds,
  orgInView,
  orgOf,
  PersonFacts,
  requireOrg,
  seesWholeOrg,
} from '@shared/tenancy';
import { ListUsersScope } from '../repositories/user.repository';
import { User } from '../entities/user.entity';

/** The caller (the signed-in user). */
export type ActorContext = AuthenticatedUser;

export function factsOf(u: User): PersonFacts {
  return { id: u.id, role: u.role, companyId: u.companyId, departmentId: u.departmentId };
}

/**
 * Who may see and change whom (4.0, docs/4.0/SPEC.md 1.2), on top of the shared
 * tenancy rules: an Admin or Super Admin (in the organisation they act in) sees
 * and changes its Managers and Staff (a Super Admin also its Admin); a Manager
 * sees the Staff of their departments and changes nobody; Staff see themselves.
 */
export class UserAccessService {
  isAdminRole(role: Role): boolean {
    return role === Role.SUPER_ADMIN || role === Role.ADMIN;
  }

  /**
   * The list filter for everyone the caller may see. A Super Admin or the Super
   * Manager with no organisation picked ("All organisations", 3.3) sees everyone
   * in every live organisation except Super Admins; anyone else without an
   * organisation sees themselves only.
   */
  listScopeFor(actor: ActorContext): ListUsersScope {
    if (seesEveryOrg(actor.role) && !orgInView(actor)) {
      return { anyOrg: true, excludeRoles: [Role.SUPER_ADMIN] };
    }
    const companyId = orgOf(actor);
    if (!companyId) return { ids: [actor.id] };
    if (seesWholeOrg(actor)) return { companyId, excludeRoles: [Role.SUPER_ADMIN] };
    if (actor.role === Role.MANAGER) {
      return { companyId, roles: [Role.USER], departmentIds: managedDeptIds(actor) };
    }
    return { ids: [actor.id] };
  }

  /**
   * Admin, or a Super Admin or the Super Manager inside an organisation (400
   * ORG_REQUIRED without one). The Super Manager adds Staff only (canAssignRole).
   */
  assertCanCreate(actor: ActorContext): string {
    if (!seesWholeOrg(actor)) {
      throw new ForbiddenError('Only the organisation admin can add people.');
    }
    return requireOrg(actor);
  }

  /** Whether `actor` may give a new or existing account the role `role`. */
  canAssignRole(actor: ActorContext, role: Role | string): boolean {
    return assignableRoles(actor.role).includes(role as Role);
  }

  /**
   * 403 ROLE_NOT_ALLOWED when `actor` may not give `role` (assignableRoles): the
   * Super Manager gives Staff only, and only a Super Admin makes a Super Manager.
   * Unknown role names, Admin and Super Admin are left to the placement rules
   * (400 ROLE_NOT_ALLOWED: an Admin comes from Organisations).
   */
  assertCanAssignRole(actor: ActorContext, role: Role | string): void {
    if (role !== Role.SUPER_MANAGER && role !== Role.MANAGER && role !== Role.USER) return;
    if (this.canAssignRole(actor, role)) return;
    throw new ForbiddenError(
      actor.role === Role.SUPER_MANAGER
        ? 'The Super Manager adds and edits Staff only.'
        : role === Role.SUPER_MANAGER
          ? 'Only a Super Admin can make someone a Super Manager.'
          : 'You cannot give that role.',
      'ROLE_NOT_ALLOWED',
    ).withDetails({ field: 'role' });
  }

  canView(actor: ActorContext, target: User): boolean {
    return canSeePerson(actor, factsOf(target));
  }

  /**
   * Whether `actor` may change `target` (edit, block, delete, screenshots,
   * agent download, credentials). Self-service is handled by each use case.
   */
  ownsTarget(actor: ActorContext, target: User): boolean {
    return canEditPerson(actor, factsOf(target));
  }

  /** 404 when `target` is missing or out of sight; 403 when visible but not editable. */
  assertCanEdit(actor: ActorContext, target: User | null | undefined): User {
    if (!target) return assertCanEdit(actor, null, 'user') as never;
    assertCanEdit(actor, factsOf(target), 'user');
    return target;
  }
}
