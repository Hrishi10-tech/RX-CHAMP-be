import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { CACHE_SERVICE, CacheService } from '@shared/cache/cache.port';
import { UserStatus } from '@shared/types/user.types';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';

/**
 * Blocks (DISABLED) or unblocks (ACTIVE) a user. Idempotent — setting the status
 * a user already has succeeds quietly, so two admins clicking a stale list row
 * don't get a conflict.
 *
 * Blocking takes effect immediately: every authenticated request re-reads the
 * user's status, and login / refresh / agent-enrollment all reject non-ACTIVE.
 */
@Injectable()
export class SetUserStatusUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CACHE_SERVICE) private readonly cache: CacheService,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string, status: UserStatus): Promise<PublicUser> {
    if (me.role === Role.USER) {
      throw new ForbiddenError('You are not allowed to change a user\'s status');
    }
    // Checked before the lookup so self always gets this message rather than the
    // "unknown user" a manager would otherwise get for their own id.
    if (targetId === me.id) {
      throw new ValidationError('You cannot change your own account status');
    }

    const target = await this.users.findById(targetId);
    // Deliberately "unknown" and not 403 for a user they may not touch, so ids
    // can't be probed for existence.
    if (!target || !this.access.ownsTarget(me, target)) {
      throw new NotFoundError('Unknown user');
    }

    await this.assertNotLastAdmin(target.role, target.isActive(), status);

    target.changeStatus(status);
    const saved = await this.users.save(target);
    await this.cache.del(`user:profile:${targetId}`);

    return UserMapper.toPublic(saved);
  }

  /**
   * Blocking the only remaining active admin would lock everyone out of every
   * admin-only route, with no way back in through the API. Only checked on a real
   * ACTIVE → DISABLED transition, so re-blocking stays idempotent.
   */
  private async assertNotLastAdmin(
    role: Role,
    targetIsActive: boolean,
    next: UserStatus,
  ): Promise<void> {
    if (next !== 'DISABLED' || !targetIsActive || !this.access.isAdminRole(role)) return;

    const [superAdmins, admins] = await Promise.all([
      this.users.count({ role: Role.SUPER_ADMIN, status: 'ACTIVE' }),
      this.users.count({ role: Role.ADMIN, status: 'ACTIVE' }),
    ]);

    if (superAdmins + admins <= 1) {
      throw new ValidationError(
        'This is the last active admin. Promote or activate another admin before blocking this one.',
      );
    }
  }
}
