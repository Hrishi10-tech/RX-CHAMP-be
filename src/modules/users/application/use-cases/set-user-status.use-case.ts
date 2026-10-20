import { Inject, Injectable } from '@nestjs/common';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { ForbiddenError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { CACHE_SERVICE, CacheService } from '@shared/cache/cache.port';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '../../domain/events/user-access-changed.event';
import { UserStatus } from '@shared/types/user.types';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';

/**
 * Blocks (DISABLED) or unblocks (ACTIVE) a person: Admin (their organisation's
 * Managers and Staff) or Super Admin (also the organisation's Admin). Idempotent,
 * so two admins clicking a stale list row don't get a conflict. Managers: 403 for
 * their Staff, 404 for anyone else; Staff: 403.
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
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly audit: AuditLogService,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string, status: UserStatus): Promise<PublicUser> {
    if (me.role === Role.USER) {
      throw new ForbiddenError("You are not allowed to change a user's status");
    }
    // Checked before the lookup so self always gets this message.
    if (targetId === me.id) {
      throw new ValidationError('You cannot change your own account status');
    }

    const target = this.access.assertCanEdit(me, await this.users.findById(targetId));
    await this.assertNotLastSuperAdmin(target.role, target.isActive(), status);

    const changed = target.status !== status;
    target.changeStatus(status);
    const saved = await this.users.save(target);
    await this.cache.del(`user:profile:${targetId}`);
    if (changed) {
      await this.events.publish(
        UserAccessChangedEvent.eventName,
        new UserAccessChangedEvent(targetId, ['STATUS'], new Date(), status === 'ACTIVE'),
      );
      await this.audit.record({
        actorId: me.id,
        action: 'USER_STATUS_CHANGED',
        entity: 'USER',
        entityId: targetId,
        metadata: { status },
      });
    }

    return UserMapper.toPublic(saved);
  }

  /**
   * Blocking the only remaining active Super Admin would lock everyone out of
   * every Super Admin route. (4.0 people endpoints never reach a Super Admin;
   * kept as a guard.) Only checked on a real ACTIVE -> DISABLED transition.
   */
  private async assertNotLastSuperAdmin(
    role: Role,
    targetIsActive: boolean,
    next: UserStatus,
  ): Promise<void> {
    if (next !== 'DISABLED' || !targetIsActive || role !== Role.SUPER_ADMIN) return;

    const superAdmins = await this.users.count({ role: Role.SUPER_ADMIN, status: 'ACTIVE' });
    if (superAdmins <= 1) {
      throw new ValidationError(
        'This is the last active Super Admin. Promote or activate another Super Admin before blocking this one.',
      );
    }
  }
}
