import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { CACHE_SERVICE, CacheService } from '@shared/cache/cache.port';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';

/**
 * Turns a user's automatic screenshots on or off (docs/4.0/SPEC.md 1.2: Admin for
 * their organisation, Super Admin for any; Managers no longer).
 *
 * Scope is deliberately narrow: this stops the agent's periodic capture and
 * nothing else. Activity tracking keeps running, and manual capture still works.
 *
 * Idempotent, so two admins clicking a stale row don't get a conflict.
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
    const target = this.access.assertCanEdit(me, await this.users.findById(targetId));
    target.setScreenshotsEnabled(enabled);
    const saved = await this.users.save(target);
    await this.cache.del(`user:profile:${targetId}`);
    return UserMapper.toPublic(saved);
  }
}
