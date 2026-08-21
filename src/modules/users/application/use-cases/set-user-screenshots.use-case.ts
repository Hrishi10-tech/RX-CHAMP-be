import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { CACHE_SERVICE, CacheService } from '@shared/cache/cache.port';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';

/**
 * Turns a user's automatic screenshots on or off. Admins may set it for anyone,
 * a manager only for their own reports.
 *
 * Scope is deliberately narrow: this stops the agent's periodic capture and
 * nothing else. Activity tracking keeps running, and a manager's manual capture
 * still works — the two are unrelated.
 *
 * Idempotent, so two managers clicking a stale row don't get a conflict.
 */
@Injectable()
export class SetUserScreenshotsUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CACHE_SERVICE) private readonly cache: CacheService,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string, enabled: boolean): Promise<PublicUser> {
    if (me.role === Role.USER) {
      throw new ForbiddenError('You are not allowed to change screenshot settings');
    }

    const target = await this.users.findById(targetId);
    // Deliberately "unknown" rather than 403 for someone they may not touch, so
    // ids can't be probed for existence — same as changing a user's status.
    if (!target || !this.access.ownsTarget(me, target)) {
      throw new NotFoundError('Unknown user');
    }

    target.setScreenshotsEnabled(enabled);
    const saved = await this.users.save(target);
    await this.cache.del(`user:profile:${targetId}`);

    return UserMapper.toPublic(saved);
  }
}
