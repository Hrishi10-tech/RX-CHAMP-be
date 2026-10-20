import { Role, assignableRoles } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import {
  assertCanEdit,
  canEditPerson,
  canSeePerson,
  isAdminLike,
  managedDeptIds,
  orgOf,
  PersonFacts,
  requireOrg,
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
   * The list filter for everyone the caller may see. A Super Admin must have
   * chosen an organisation (400 ORG_REQUIRED); anyone else without one sees
   * themselves only.
   */
  listScopeFor(actor: ActorContext): ListUsersScope {
    if (actor.role === Role.SUPER_ADMIN) requireOrg(actor);
    const companyId = orgOf(actor);
    if (!companyId) return { ids: [actor.id] };
    if (isAdminLike(actor)) return { companyId, excludeRoles: [Role.SUPER_ADMIN] };
    if (actor.role === Role.MANAGER) {
      return { companyId, roles: [Role.USER], departmentIds: managedDeptIds(actor) };
    }
    return { ids: [actor.id] };
  }

  /** Admin, or a Super Admin inside an organisation (400 ORG_REQUIRED without one). */
  assertCanCreate(actor: ActorContext): string {
    if (!isAdminLike(actor)) {
      throw new ForbiddenError('Only the organisation admin can add people.');
    }
    return requireOrg(actor);
  }

  /** Whether `actor` may give a new or existing account the role `role`. */
  canAssignRole(actor: ActorContext, role: Role): boolean {
    return assignableRoles(actor.role).includes(role);
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
