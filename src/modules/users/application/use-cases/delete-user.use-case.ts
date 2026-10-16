import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { CACHE_SERVICE, CacheService } from '@shared/cache/cache.port';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '../../domain/events/user-access-changed.event';
import { UserAccessService } from '../../domain/services/user-access.service';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { DeleteUserResult } from '../user.types';

@Injectable()
export class DeleteUserUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(CACHE_SERVICE) private readonly cache: CacheService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string): Promise<DeleteUserResult> {
    if (me.role === Role.USER) throw new ForbiddenError('Not allowed');

    const target = await this.users.findById(targetId);
    if (!target) throw new NotFoundError('Unknown user');
    if (target.id === me.id) throw new ValidationError('You cannot delete yourself');
    if (!this.access.ownsTarget(me, target)) throw new ForbiddenError('Not your team member');
    if (target.role === Role.SUPER_ADMIN && target.isActive()) {
      const superAdmins = await this.users.count({ role: Role.SUPER_ADMIN, status: 'ACTIVE' });
      if (superAdmins <= 1) {
        throw new ValidationError('You cannot delete the last active Super Admin.');
      }
    }

    await this.users.softDelete(target.id);
    await this.cache.del(`user:profile:${targetId}`);
    await this.events.publish(
      UserAccessChangedEvent.eventName,
      new UserAccessChangedEvent(target.id, ['DELETED'], new Date(), false),
    );

    return { deleted: true, id: target.id };
  }
}
