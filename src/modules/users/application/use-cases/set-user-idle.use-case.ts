import { Inject, Injectable } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import { ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { requireOrg } from '@shared/tenancy';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { UserAccessService } from '../../domain/services/user-access.service';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';

const MINUTES = { min: 2, max: 60 } as const;

/**
 * POST /users/:id/idle (docs/4.0/SPEC.md 2.5): a person's input-tracking override.
 * null on either field = use the department's (else the organisation's) setting.
 * Agents re-read their config on org.config-changed (IDLE).
 */
@Injectable()
export class SetUserIdleUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(
    me: AuthenticatedUser,
    targetId: string,
    enabled: boolean | null,
    minutes: number | null,
  ): Promise<PublicUser> {
    const target = this.access.assertCanEdit(me, await this.users.findById(targetId));
    if (
      minutes !== null &&
      (!Number.isInteger(minutes) || minutes < MINUTES.min || minutes > MINUTES.max)
    ) {
      throw new ValidationError(
        `Minutes must be a whole number from ${MINUTES.min} to ${MINUTES.max}, or empty to use the department setting.`,
      ).withDetails({ field: 'minutes' });
    }
    if (target.idleEnabled === enabled && target.idleMinutes === minutes) {
      return UserMapper.toPublic(target);
    }
    target.setIdle(enabled, minutes);
    const saved = await this.users.save(target);
    await this.events.publish(
      OrgConfigChangedEvent.eventName,
      new OrgConfigChangedEvent(requireOrg(me), 'IDLE', new Date()),
    );
    return UserMapper.toPublic(saved);
  }
}
