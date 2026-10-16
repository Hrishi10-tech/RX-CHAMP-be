import { Role, assignableRoles, outranks } from '@shared/rbac/roles.enum';
import { UnauthorizedAction } from '@shared/exceptions/domain.exception';
import { ListUsersScope } from '../repositories/user.repository';
import { User } from '../entities/user.entity';

export interface ActorContext {
  id: string;
  role: Role;
  department: string | null;
}

/**
 * Who may see and change whom.
 *
 * Super Admin -> Manager -> Staff. A Super Admin reaches everyone. A Manager
 * reaches only their direct reports (users.manager_id) and only ever acts on
 * Staff. Staff reach only themselves. Writes additionally require the actor to
 * outrank the target, so nobody can act on a peer or a superior, with one
 * exception: a Super Admin may act on another Super Admin (there is nobody
 * above them to do it), guarded elsewhere so the last one cannot be removed.
 */
export class UserAccessService {
  private readonly listScopes: Record<Role, (actor: ActorContext) => ListUsersScope> = {
    [Role.SUPER_ADMIN]: () => ({}),
    [Role.MANAGER]: (actor) => ({ managerId: actor.id }),
    [Role.USER]: (actor) => ({ ids: [actor.id] }),
  };

  isAdminRole(role: Role): boolean {
    return role === Role.SUPER_ADMIN;
  }

  listScopeFor(actor: ActorContext): ListUsersScope {
    return this.listScopes[actor.role](actor);
  }

  assertCanCreate(actor: ActorContext): void {
    if (assignableRoles(actor.role).length === 0) {
      throw new UnauthorizedAction('You cannot create users');
    }
  }

  /** Whether `actor` may give a new or existing account the role `role`. */
  canAssignRole(actor: ActorContext, role: Role): boolean {
    return assignableRoles(actor.role).includes(role);
  }

  canView(actor: ActorContext, target: User): boolean {
    if (target.id === actor.id) return true;
    if (actor.role === Role.SUPER_ADMIN) return true;
    if (actor.role === Role.MANAGER) return target.managerId === actor.id;
    return false;
  }

  /**
   * Whether `actor` may change `target` (edit, block, delete, screenshots,
   * agent download). Self-service is handled by each use case, not here.
   */
  ownsTarget(actor: ActorContext, target: User): boolean {
    if (target.id === actor.id) return false;
    if (actor.role === Role.SUPER_ADMIN) return true;
    if (actor.role === Role.MANAGER) {
      return target.managerId === actor.id && outranks(actor.role, target.role);
    }
    return false;
  }
}
