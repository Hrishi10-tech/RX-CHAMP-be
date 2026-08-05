
import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { CACHE_SERVICE, CacheService } from '@shared/cache/cache.port';
import { UserAccessService } from '../../domain/services/user-access.service';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { DeleteUserResult } from '../user.types';

@Injectable()
export class DeleteUserUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CACHE_SERVICE) private readonly cache: CacheService,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string): Promise<DeleteUserResult> {

    if (me.role === Role.USER) throw new ForbiddenError('Not allowed');

    const target = await this.users.findById(targetId);
    if (!target) throw new NotFoundError('Unknown user');
    if (target.id === me.id) throw new ValidationError('You cannot delete yourself');
    if (!this.access.ownsTarget(me, target)) throw new ForbiddenError('Not your team member');

    await this.users.softDelete(target.id);
    await this.cache.del(`user:profile:${targetId}`);

    return { deleted: true, id: target.id };
  }
}
