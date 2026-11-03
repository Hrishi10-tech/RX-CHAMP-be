import { Inject, Injectable } from '@nestjs/common';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { ConflictError, ForbiddenError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { UserCreatedEvent } from '../../domain/events/user-created.event';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { Email } from '../../domain/value-objects/email.vo';
import { UserMapper } from '../mappers/user.mapper';
import { PublicUser } from '../user.types';
import { CreateSuperManagerDto } from '../dto';
import { MIN_PASSWORD_LENGTH } from '../user.constants';

const NAME_MAX = 60;
const DESIGNATION_MAX = 100;
const PASSWORD_MAX = 128;

/**
 * Super Manager accounts (3.3, ported onto 4.0). A Super Admin alone lists and
 * adds them, organisation selected or not: the account belongs to no organisation
 * (companyId null), no department and no grants; it acts in one by picking it
 * (X-Org-Id), like the Super Admin. Edit (names, email, designation), block,
 * password and delete go through the /users/:id endpoints, where the tenancy rules
 * let a Super Admin, and nobody else, change a Super Manager.
 */
@Injectable()
export class SuperManagersUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly audit: AuditLogService,
  ) {}

  async list(me: AuthenticatedUser): Promise<PublicUser[]> {
    this.assertSuperAdmin(me);
    const rows = await this.users.findAll({ roles: [Role.SUPER_MANAGER], sort: 'name_asc' });
    return rows.map((u) => UserMapper.toPublic(u));
  }

  async create(me: AuthenticatedUser, dto: CreateSuperManagerDto): Promise<PublicUser> {
    this.assertSuperAdmin(me);
    const firstName = (dto.firstName ?? '').trim();
    const lastName = (dto.lastName ?? '').trim();
    const email = (dto.email ?? '').toLowerCase().trim();
    const password = dto.password ?? '';
    const designation = (dto.designation ?? '').trim();

    if (!firstName || !lastName || !email || !password) {
      throw new ValidationError('First name, last name, email and password are required.');
    }
    if (firstName.length > NAME_MAX || lastName.length > NAME_MAX) {
      throw new ValidationError(`Keep names to ${NAME_MAX} characters or fewer.`);
    }
    try {
      Email.create(email);
    } catch {
      throw new ValidationError('Enter a valid email address.').withDetails({ field: 'email' });
    }
    if (password.trim().length < MIN_PASSWORD_LENGTH || password.length > PASSWORD_MAX) {
      throw new ValidationError(
        `Use a password of ${MIN_PASSWORD_LENGTH} to ${PASSWORD_MAX} characters.`,
        'WEAK_PASSWORD',
      ).withDetails({ field: 'password' });
    }
    if (designation.length > DESIGNATION_MAX) {
      throw new ValidationError(`Keep the designation to ${DESIGNATION_MAX} characters or fewer.`);
    }
    if (await this.users.findByEmail(email)) {
      throw new ConflictError('That email address is already in use.', 'EMAIL_IN_USE');
    }

    const user = await this.users.create({
      email,
      passwordHash: await this.hasher.hash(password),
      firstName,
      lastName,
      role: Role.SUPER_MANAGER,
      designation: designation || undefined,
      departmentId: null,
      managedDepartmentIds: [],
      createdById: me.id,
    });
    await this.events.publish(
      UserCreatedEvent.eventName,
      new UserCreatedEvent(user.id, user.email, user.role, me.id, new Date()),
    );
    await this.audit.record({
      actorId: me.id,
      action: 'USER_CREATED',
      entity: 'USER',
      entityId: user.id,
      metadata: { role: Role.SUPER_MANAGER, companyId: null },
    });
    return UserMapper.toPublic(user);
  }

  private assertSuperAdmin(me: AuthenticatedUser): void {
    if (me.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError('Only a Super Admin manages Super Managers.');
    }
  }
}
