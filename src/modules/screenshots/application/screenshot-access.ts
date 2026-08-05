import { ForbiddenException } from '@nestjs/common';
import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ScreenshotAccessReader } from '../domain/screenshot-access.reader';

/**
 * A user may view / request captures for a target when: it's themselves, they're
 * an admin, or they are the target's manager. Throws ForbiddenException otherwise.
 */
export async function assertCanAccess(
  me: AuthenticatedUser,
  targetUserId: string,
  access: ScreenshotAccessReader,
): Promise<void> {
  if (me.id === targetUserId) return;
  if (me.role === Role.ADMIN || me.role === Role.SUPER_ADMIN) return;

  const managerId = await access.findManagerId(targetUserId);
  if (managerId === undefined) throw new ForbiddenException('User not found');
  if (managerId === me.id) return;

  throw new ForbiddenException('You can only access screenshots for your own team');
}
