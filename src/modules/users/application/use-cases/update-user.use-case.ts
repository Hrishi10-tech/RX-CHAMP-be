import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ROLE_LABEL, Role } from '@shared/rbac/roles.enum';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessService } from '../../domain/services/user-access.service';
import {
  UserAccessChange,
  UserAccessChangedEvent,
} from '../../domain/events/user-access-changed.event';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { UpdateUserDto } from '../dto';

/**
 * Edits a user.
 *
 *  - Everyone may change their own first and last name, nothing else about
 *    themselves. Department drives which shift (and break times) apply, and the
 *    email is the sign-in identity, so neither is self-service.
 *  - A Manager may edit their own staff: name, email, designation, department.
 *  - A Super Admin may edit anyone, and is the only one who may change a role or
 *    who someone reports to.
 */
@Injectable()
export class UpdateUserUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(me: AuthenticatedUser, targetId: string, dto: UpdateUserDto): Promise<PublicUser> {
    const target = await this.users.findById(targetId);
    const self = target?.id === me.id;
    if (!target || (!self && !this.access.ownsTarget(me, target))) {
      throw new NotFoundError('Unknown user');
    }

    if (self) {
      const restricted =
        dto.email !== undefined ||
        dto.designation !== undefined ||
        dto.department !== undefined ||
        dto.role !== undefined ||
        dto.managerId !== undefined;
      if (restricted) {
        throw new ForbiddenError(
          'You can change your own name only. Ask your manager to change anything else.',
        );
      }
    }

    if ((dto.role !== undefined || dto.managerId !== undefined) && me.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError('Only a Super Admin can change roles or reporting lines.');
    }

    if (dto.email !== undefined && target.changeEmail(dto.email)) {
      // changeEmail returns false when it's the same address, so we only pay for
      // the lookup on a real change — and never conflict a user with themselves.
      const holder = await this.users.findByEmail(target.email);
      if (holder && holder.id !== target.id) {
        throw new ConflictError(`Email '${target.email}' is already in use`);
      }
    }

    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      target.rename(dto.firstName ?? target.firstName, dto.lastName ?? target.lastName);
    }
    if (dto.designation !== undefined) target.setDesignation(dto.designation);
    if (dto.department !== undefined) target.setDepartment(dto.department);

    const changes: UserAccessChange[] = [];
    if (dto.role !== undefined && dto.role !== target.role) {
      await this.changeRole(target.id, target.role, dto.role, target.isActive());
      target.changeRole(dto.role);
      changes.push('ROLE');
    }

    if (dto.managerId !== undefined) {
      const managerId = dto.managerId || null;
      if (managerId) {
        const manager = await this.users.findById(managerId);
        if (!manager || !manager.isActive()) throw new ValidationError('Unknown manager');
        if (manager.role === Role.USER) throw new ValidationError('Staff cannot have reports');
        if (manager.managerId === target.id) {
          throw new ValidationError('That would make two people report to each other');
        }
      }
      if (managerId !== target.managerId) changes.push('MANAGER');
      target.assignManager(managerId);
    }

    const saved = await this.users.save(target);
    if (changes.length) {
      await this.events.publish(
        UserAccessChangedEvent.eventName,
        new UserAccessChangedEvent(target.id, changes, new Date()),
      );
    }
    return UserMapper.toPublic(saved);
  }

  private async changeRole(targetId: string, from: Role, to: Role, active: boolean) {
    if (!Object.values(Role).includes(to)) {
      throw new ValidationError(`Unknown role '${to}'`);
    }
    if (from === Role.SUPER_ADMIN && active) {
      const superAdmins = await this.users.count({ role: Role.SUPER_ADMIN, status: 'ACTIVE' });
      if (superAdmins <= 1) {
        throw new ValidationError(
          `This is the last active Super Admin and cannot become a ${ROLE_LABEL[to]}.`,
        );
      }
    }
    if (from === Role.MANAGER && to === Role.USER) {
      const reports = await this.users.count({ managerId: targetId, status: 'ACTIVE' });
      if (reports > 0) {
        throw new ValidationError(
          `This manager still has ${reports} active staff. Move them to another manager first.`,
        );
      }
    }
  }
}
