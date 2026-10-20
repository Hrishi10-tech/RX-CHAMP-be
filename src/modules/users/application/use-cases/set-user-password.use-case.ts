import { Inject, Injectable } from '@nestjs/common';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { UserAccessService } from '../../domain/services/user-access.service';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import {
  UserAccessChange,
  UserAccessChangedEvent,
} from '../../domain/events/user-access-changed.event';
import { MIN_PASSWORD_LENGTH } from '../user.constants';

/**
 * An administrator sets someone's password (they forgot it, or it leaked): Admin
 * for their organisation's Managers and Staff, Super Admin also for its Admin.
 * Your own password is changed through /auth/change-password, which needs the
 * current one.
 *
 * "Sign out everywhere" also ends every session and invalidates the person's
 * installer and setup-code tokens (enrollVersion), since the account may be
 * compromised.
 */
@Injectable()
export class SetUserPasswordUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    me: AuthenticatedUser,
    targetId: string,
    newPassword: string,
    signOutEverywhere = false,
  ): Promise<{ updated: true; id: string; signedOut: boolean }> {
    if (targetId === me.id) {
      throw new ValidationError(
        'Change your own password from your profile.',
        'USE_CHANGE_PASSWORD',
      );
    }
    const target = this.access.assertCanEdit(me, await this.users.findById(targetId));
    if ((newPassword ?? '').length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, 'WEAK_PASSWORD');
    }

    target.setPasswordHash(await this.hasher.hash(newPassword));
    await this.users.save(target);
    if (signOutEverywhere) await this.users.bumpEnrollVersion(target.id);

    const changes: UserAccessChange[] = signOutEverywhere ? ['PASSWORD', 'SIGN_OUT'] : ['PASSWORD'];
    await this.events.publish(
      UserAccessChangedEvent.eventName,
      new UserAccessChangedEvent(target.id, changes, new Date(), target.isActive()),
    );
    await this.audit.record({
      actorId: me.id,
      action: 'USER_PASSWORD_SET',
      entity: 'USER',
      entityId: target.id,
      metadata: { signOutEverywhere },
    });
    return { updated: true, id: target.id, signedOut: signOutEverywhere };
  }
}
