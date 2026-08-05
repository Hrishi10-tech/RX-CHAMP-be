import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';

@Injectable()
export class GetProfileUseCase {
  private readonly access = new UserAccessService();

  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  /**
   * Full detail for one user. Admins see anyone, a manager sees their reports
   * (and themselves), everyone else sees only themselves. A user they may not
   * view reads as "unknown" rather than "forbidden", so ids can't be probed.
   *
   * Disabled users are returned, not rejected — `status` is part of the payload
   * and the detail screen is where you go to re-enable someone.
   */
  async execute(me: AuthenticatedUser, targetId: string): Promise<PublicUser> {
    const target = await this.users.findById(targetId);
    if (!target || !this.access.canView(me, target)) {
      throw new NotFoundError('Unknown user');
    }
    return UserMapper.toPublic(target);
  }
}
