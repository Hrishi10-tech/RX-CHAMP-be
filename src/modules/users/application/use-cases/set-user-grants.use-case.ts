import { Inject, Injectable } from '@nestjs/common';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { UserGrants } from '../../domain/entities/user.entity';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { sameGrants } from '../people-placement';
import { PublicUser } from '../user.types';

/**
 * POST /users/:id/grants (docs/4.0/SPEC.md 2.2): which detail sections a Manager
 * may see for the Staff of their departments. Admin or Super Admin, Managers of
 * their organisation only. A change reconnects the Manager's live sockets so
 * activity and screenshot rooms follow at once.
 */
@Injectable()
export class SetUserGrantsUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly audit: AuditLogService,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string, grants: UserGrants): Promise<PublicUser> {
    const target = this.access.assertCanEdit(me, await this.users.findById(targetId));
    if (target.role !== Role.MANAGER) {
      throw new ValidationError('Grants apply to managers only.', 'NOT_A_MANAGER');
    }
    const before = target.grants;
    if (sameGrants(before, grants)) return UserMapper.toPublic(target);
    target.setGrants(grants);
    const saved = await this.users.save(target);
    await this.events.publish(
      UserAccessChangedEvent.eventName,
      new UserAccessChangedEvent(target.id, ['ROLE'], new Date(), saved.isActive()),
    );
    await this.audit.record({
      actorId: me.id,
      action: 'USER_GRANTS_CHANGED',
      entity: 'USER',
      entityId: target.id,
      metadata: { from: before, to: grants },
    });
    return UserMapper.toPublic(saved);
  }
}
