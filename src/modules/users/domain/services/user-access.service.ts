
import { Role } from '@shared/rbac/roles.enum';
import { UnauthorizedAction } from '@shared/exceptions/domain.exception';
import { ListUsersScope } from '../repositories/user.repository';
import { User } from '../entities/user.entity';

export interface ActorContext {
  id: string;
  role: Role;
  department: string | null;
}

export class UserAccessService {
  private readonly listScopes: Record<Role, (actor: ActorContext) => ListUsersScope> = {
    [Role.SUPER_ADMIN]: () => ({}),
    [Role.ADMIN]: () => ({}),
    [Role.MANAGER]: (actor) => ({ managerId: actor.id }),
    [Role.USER]: (actor) => ({ ids: [actor.id] }),
  };

  isAdminRole(role: Role): boolean {
    return role === Role.SUPER_ADMIN || role === Role.ADMIN;
  }

 
  listScopeFor(actor: ActorContext): ListUsersScope {
    return this.listScopes[actor.role](actor);
  }

  assertCanCreate(actor: ActorContext): void {
    if (actor.role === Role.USER) {
      throw new UnauthorizedAction('You cannot create users');
    }
  }


  canView(actor: ActorContext, target: User): boolean {
    if (this.isAdminRole(actor.role)) return true;
    if (actor.role === Role.MANAGER) return target.managerId === actor.id || target.id === actor.id;
    return target.id === actor.id;
  }

  
  ownsTarget(actor: ActorContext, target: User): boolean {
    if (this.isAdminRole(actor.role)) return true;
    return target.managerId === actor.id;
  }
}
