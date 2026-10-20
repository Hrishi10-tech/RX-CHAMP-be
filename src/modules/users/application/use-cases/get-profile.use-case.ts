import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { isAdminLike } from '@shared/tenancy';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser, UserBriefItem } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';

@Injectable()
export class GetProfileUseCase {
  private readonly access = new UserAccessService();

  constructor(@Inject(USER_REPOSITORY) private readonly users: UserRepository) {}

  /**
   * One user. Admins (and a Super Admin) see anyone in the organisation, a manager
   * sees the Staff of their departments, everyone sees themselves. A user they may
   * not view reads as "unknown" rather than "forbidden", so ids can't be probed.
   *
   * 4.0: the full profile (grants, input tracking, shift, status, ...) is for
   * Admins and Super Admins, and for the person themselves (the agent reads its
   * own role and screenshot switch here); anyone else, a Manager, gets the brief
   * row their GET /users shows (id, name, email, designation, department).
   *
   * Disabled users are returned, not rejected — `status` is part of the payload
   * and the detail screen is where you go to re-enable someone.
   */
  async execute(me: AuthenticatedUser, targetId: string): Promise<PublicUser | UserBriefItem> {
    const target = await this.users.findById(targetId);
    if (!target || !this.access.canView(me, target)) {
      throw new NotFoundError('Unknown user');
    }
    if (target.id === me.id || isAdminLike(me)) return UserMapper.toPublic(target);
    return UserMapper.toBrief(target);
  }
}
