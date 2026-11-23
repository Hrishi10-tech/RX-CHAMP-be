import { Inject, Injectable } from '@nestjs/common';
import { AuditEntry, AuditLogService } from '@shared/audit/audit-log.service';
import { ConflictError, ForbiddenError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { effectiveAvatarId } from '@shared/avatars/person-avatar';
import { AvatarChangedEvent } from '@shared/events/avatar-changed.event';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { requireOrg } from '@shared/tenancy';
import { User } from '../../domain/entities/user.entity';
import { UserAccessService, canSetGender } from '../../domain/services/user-access.service';
import {
  FormerPlacement,
  UserAccessChangedEvent,
} from '../../domain/events/user-access-changed.event';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import {
  DEPARTMENT_READER,
  DepartmentReader,
} from '../../domain/repositories/department-reader.port';
import { UpdateUserDto } from '../dto';
import { resolvePlacement, sameGrants, sameIds } from '../people-placement';

/**
 * Edits a person (docs/4.0/SPEC.md 5.3).
 *
 *  - Everyone may change their own first and last name, nothing else about
 *    themselves (department, role and sign-in address are the Admin's).
 *  - An Admin edits the Managers and Staff of their organisation: names, email,
 *    designation, role (Manager <-> Staff), department(s), grants.
 *  - A Super Admin (inside an organisation) also edits its Admin: names, email,
 *    designation. An Admin's role and departments never change here.
 *  - Managers change nobody (403 for their Staff, 404 for anyone else).
 *
 * A change of role, department(s) or grants reconnects the person's live sockets
 * with the right rooms (UserAccessChangedEvent ROLE) and is audited.
 *
 * 3.6 gender (the avatar library) is set by whoever edits the person as their
 * organisation admin or a Super Admin (canSetGender): an Admin for its Managers and
 * Staff, a Super Admin for anyone but another Super Admin, and for themselves (nobody
 * else can). The Super Manager, Managers and Staff get 403 GENDER_FORBIDDEN. A changed
 * gender resets the avatar to the new default and pushes avatar:changed.
 */
@Injectable()
export class UpdateUserUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(DEPARTMENT_READER) private readonly departments: DepartmentReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly audit: AuditLogService,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string, dto: UpdateUserDto): Promise<PublicUser> {
    const found = await this.users.findById(targetId);
    if (found && found.id === me.id) return this.selfRename(me, found, dto);
    const target = this.access.assertCanEdit(me, found);
    if (dto.gender !== undefined && !canSetGender(me, target)) throw genderForbidden();
    const placementAsked =
      dto.role !== undefined ||
      dto.departmentId !== undefined ||
      dto.departmentIds !== undefined ||
      dto.grants !== undefined;
    // 3.3: a Super Manager account (no organisation) is edited by a Super Admin from
    // anywhere: names, email, designation. Its role never changes here.
    if (target.role === Role.SUPER_MANAGER && placementAsked) {
      throw new ForbiddenError(
        "A Super Manager's role cannot be changed. Edit their name or email instead.",
        'SUPER_MANAGER_ROLE_FIXED',
      );
    }
    if (dto.role !== undefined && dto.role !== target.role) {
      this.access.assertCanAssignRole(me, dto.role);
    }
    const org = target.role === Role.SUPER_MANAGER ? null : requireOrg(me);
    const audits: AuditEntry[] = [];
    const entry = (action: AuditEntry['action'], metadata: Record<string, unknown>): void => {
      audits.push({ actorId: me.id, action, entity: 'USER', entityId: target.id, metadata });
    };

    if (target.role === Role.ADMIN && placementAsked) {
      throw new ForbiddenError(
        "The organisation admin's role and departments cannot be changed. Edit their name or email instead.",
        'ADMIN_ROLE_FIXED',
      );
    }

    if (dto.email !== undefined) {
      const before = target.email;
      if (target.changeEmail(dto.email)) {
        const holder = await this.users.findByEmail(target.email);
        if (holder && holder.id !== target.id) {
          throw new ConflictError('That email address is already in use.', 'EMAIL_IN_USE');
        }
        entry('USER_EMAIL_CHANGED', { from: before, to: target.email });
      }
    }
    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      const first = (dto.firstName ?? target.firstName).trim();
      if (!first)
        throw new ValidationError('Enter a first name.').withDetails({ field: 'firstName' });
      target.rename(first, (dto.lastName ?? target.lastName).trim());
    }
    if (dto.designation !== undefined) target.setDesignation(dto.designation);

    let accessChanged = false;
    let formerPlacement: FormerPlacement | undefined;
    if (placementAsked) {
      const before = {
        role: target.role,
        departmentId: target.departmentId,
        managed: target.managedDepartmentIds,
        grants: target.grants,
      };
      // 3.6: approvals that waited on these departments' managers are announced again.
      formerPlacement = {
        role: before.role,
        departmentId: before.departmentId,
        managedDepartmentIds: [...before.managed],
      };
      const placement = await resolvePlacement(
        this.departments,
        org ?? requireOrg(me),
        {
          role: dto.role ?? target.role,
          departmentId: dto.departmentId,
          departmentIds: dto.departmentIds,
          grants: dto.grants,
        },
        {
          role: target.role,
          departmentId: target.departmentId,
          managedDepartmentIds: target.managedDepartmentIds,
          grants: target.grants,
        },
      );
      target.changeRole(placement.role);
      target.assignDepartment(placement.department);
      target.setManagedDepartments(placement.managed);
      target.setGrants(placement.grants);

      const managedIds = placement.managed.map((d) => d.id);
      if (placement.role !== before.role) {
        entry('USER_ROLE_CHANGED', { from: before.role, to: placement.role, companyId: org });
      }
      if (
        (placement.department?.id ?? null) !== before.departmentId ||
        !sameIds(managedIds, before.managed)
      ) {
        entry('USER_DEPARTMENT_CHANGED', {
          from: { departmentId: before.departmentId, managed: before.managed },
          to: { departmentId: placement.department?.id ?? null, managed: managedIds },
        });
      }
      if (!sameGrants(placement.grants, before.grants)) {
        entry('USER_GRANTS_CHANGED', { from: before.grants, to: placement.grants });
      }
      accessChanged = audits.some((a) => a.action !== 'USER_EMAIL_CHANGED');
    }

    const genderChanged = dto.gender !== undefined && target.changeGender(dto.gender);

    const saved = await this.users.save(target);
    if (genderChanged) await this.avatarChanged(saved);
    if (accessChanged) {
      await this.events.publish(
        UserAccessChangedEvent.eventName,
        new UserAccessChangedEvent(
          target.id,
          ['ROLE'],
          new Date(),
          saved.isActive(),
          formerPlacement,
        ),
      );
    }
    await this.audit.recordMany(audits);
    return UserMapper.toPublic(saved, me);
  }

  private async avatarChanged(saved: User): Promise<void> {
    await this.events.publish(
      AvatarChangedEvent.eventName,
      new AvatarChangedEvent(saved.id, effectiveAvatarId(saved), saved.companyId),
    );
  }

  private async selfRename(
    me: AuthenticatedUser,
    self: User,
    dto: UpdateUserDto,
  ): Promise<PublicUser> {
    const restricted =
      dto.email !== undefined ||
      dto.designation !== undefined ||
      dto.role !== undefined ||
      dto.departmentId !== undefined ||
      dto.departmentIds !== undefined ||
      dto.grants !== undefined;
    if (restricted) {
      throw new ForbiddenError(
        'You can change your own name only. Ask your organisation admin to change anything else.',
      );
    }
    // 3.6: a Super Admin sets their own gender (nobody else can); anyone else, 403.
    if (dto.gender !== undefined && !canSetGender(me, self)) throw genderForbidden();
    const renamed = dto.firstName !== undefined || dto.lastName !== undefined;
    if (renamed) {
      const first = (dto.firstName ?? self.firstName).trim();
      if (!first)
        throw new ValidationError('Enter a first name.').withDetails({ field: 'firstName' });
      self.rename(first, (dto.lastName ?? self.lastName).trim());
    }
    const genderChanged = dto.gender !== undefined && self.changeGender(dto.gender);
    if (!renamed && !genderChanged) return UserMapper.toPublic(self, me);
    const saved = await this.users.save(self);
    if (genderChanged) await this.avatarChanged(saved);
    return UserMapper.toPublic(saved, me);
  }
}

function genderForbidden(): ForbiddenError {
  return new ForbiddenError(
    'Only the organisation admin or a Super Admin can set gender.',
    'GENDER_FORBIDDEN',
  );
}
