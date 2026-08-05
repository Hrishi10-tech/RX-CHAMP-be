
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthorizedError } from '../exceptions/app.exception';
import { AuthenticatedUser } from './authenticated-user';
import { Permission } from './permissions.enum';
import { PERMISSIONS_KEY } from './permissions.decorator';
import { Role } from './roles.enum';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPerms = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles?.length && !requiredPerms?.length) return true;

    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw new UnauthorizedError();

    if (requiredRoles?.length && !requiredRoles.includes(user.role)) {
      throw new ForbiddenError('You do not have the required role');
    }

    if (requiredPerms?.length) {
      const granted = new Set(user.permissions ?? []);
      const missing = requiredPerms.filter((p) => !granted.has(p));
      if (missing.length) {
        throw new ForbiddenError(`Missing permission(s): ${missing.join(', ')}`);
      }
    }

    return true;
  }
}
