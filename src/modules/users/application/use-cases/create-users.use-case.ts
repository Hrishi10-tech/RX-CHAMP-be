import { Inject, Injectable } from '@nestjs/common';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { ConflictError, NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { UserCreatedEvent } from '../../domain/events/user-created.event';
import { UserAccessService } from '../../domain/services/user-access.service';
import { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { UserMapper } from '../mappers/user.mapper';
import { CreateUsersResult, PublicUser } from '../user.types';
import { USER_REPOSITORY, UserRepository } from '../../domain/repositories/user.repository';
import { SHIFT_READER, ShiftReader, ShiftView } from '../../domain/repositories/shift-reader.port';
import {
  DEPARTMENT_READER,
  DepartmentReader,
} from '../../domain/repositories/department-reader.port';
import { CreateUserItemDto } from '../dto';
import { MIN_PASSWORD_LENGTH } from '../user.constants';
import { Placement, resolvePlacement } from '../people-placement';

const NAME_MAX = 60;
const DESIGNATION_MAX = 100;
const PASSWORD_MAX = 128;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function emailInUse(): ConflictError {
  return new ConflictError('That email address is already in use.', 'EMAIL_IN_USE');
}

/**
 * Adds people to the caller's organisation (docs/4.0/SPEC.md 5.3): Admin, or a
 * Super Admin with an organisation selected. Managers and Staff cannot (403).
 *
 *  - role MANAGER or USER (an organisation's Admin comes from Organisations);
 *  - Staff need one department (departmentId), Managers one or more (departmentIds),
 *    all of the caller's organisation; grants are for Managers;
 *  - the organisation is always the caller's, never one from the body;
 *  - users.department holds the department's name (display, 3.x shift matching).
 *
 * One person (`single`): a problem answers with its HTTP error. Several (`users`):
 * each row lands in `created` or `errors`, one bad row never fails the batch.
 *
 * Re-adding the email of a blocked account the caller may edit reactivates it with
 * the new details and password, so old credentials never come back.
 */
@Injectable()
export class CreateUsersUseCase {
  private readonly access = new UserAccessService();

  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SHIFT_READER) private readonly shifts: ShiftReader,
    @Inject(DEPARTMENT_READER) private readonly departments: DepartmentReader,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly audit: AuditLogService,
  ) {}

  async execute(
    me: AuthenticatedUser,
    incoming: CreateUserItemDto[],
    single = false,
  ): Promise<CreateUsersResult> {
    const org = this.access.assertCanCreate(me);
    const created: PublicUser[] = [];
    const errors: CreateUsersResult['errors'] = [];
    for (const row of incoming) {
      const email = (row.email ?? '').toLowerCase().trim();
      try {
        created.push(await this.createOne(me, org, row, email));
      } catch (err) {
        if (single) throw err;
        errors.push({ email, error: (err as Error).message || 'could not create user' });
      }
    }
    return { created, errors };
  }

  private async createOne(
    me: AuthenticatedUser,
    org: string,
    row: CreateUserItemDto,
    email: string,
  ): Promise<PublicUser> {
    const firstName = (row.firstName ?? '').trim();
    const lastName = (row.lastName ?? '').trim();
    const password = row.password ?? '';
    const role = (row.role ?? '').trim().toUpperCase();

    if (!firstName || !lastName || !email || !password || !role) {
      throw new ValidationError('First name, last name, email, password and role are required.');
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
      );
    }
    const designation = (row.designation ?? '').trim();
    if (designation.length > DESIGNATION_MAX) {
      throw new ValidationError(`Keep the designation to ${DESIGNATION_MAX} characters or fewer.`);
    }

    const placement = await resolvePlacement(this.departments, org, {
      role,
      departmentId: row.departmentId,
      departmentIds: row.departmentIds,
      grants: row.grants,
    });
    const shift = row.shiftId ? await this.shiftOf(org, row.shiftId) : null;

    const existing = await this.users.findByEmail(email);
    if (existing) {
      // Same message whether the address is active here, elsewhere or blocked out
      // of reach: where an address is in use is not the caller's to learn.
      // An Admin is never turned into a Manager or Staff member this way.
      const reusable =
        !existing.isActive() && !existing.isAdmin() && this.access.ownsTarget(me, existing);
      if (!reusable) throw emailInUse();
      return this.reactivate(me, existing, firstName, lastName, designation, password, placement);
    }

    const user = await this.users.create({
      email,
      passwordHash: await this.hasher.hash(password),
      firstName,
      lastName,
      role: placement.role,
      designation: designation || undefined,
      department: placement.department?.name,
      departmentId: placement.department?.id ?? null,
      managedDepartmentIds: placement.managed.map((d) => d.id),
      grants: placement.grants,
      companyId: org,
      shiftId: shift?.id,
      shiftStart: shift ? shift.start : this.hm(row.shiftStart, '10:00'),
      shiftEnd: shift ? shift.end : this.hm(row.shiftEnd, '19:00'),
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
      metadata: {
        companyId: org,
        role: placement.role,
        departmentId: placement.department?.id ?? null,
        managedDepartmentIds: placement.managed.map((d) => d.id),
        grants: placement.grants,
      },
    });
    return UserMapper.toPublic(user);
  }

  private async reactivate(
    me: AuthenticatedUser,
    existing: User,
    firstName: string,
    lastName: string,
    designation: string,
    password: string,
    placement: Placement,
  ): Promise<PublicUser> {
    existing.reactivateWith(firstName, lastName, designation || null);
    existing.changeRole(placement.role);
    existing.assignDepartment(placement.department);
    existing.setManagedDepartments(placement.managed);
    existing.setGrants(placement.grants);
    existing.setPasswordHash(await this.hasher.hash(password));
    const saved = await this.users.save(existing);
    await this.events.publish(
      UserAccessChangedEvent.eventName,
      new UserAccessChangedEvent(saved.id, ['ROLE', 'STATUS', 'PASSWORD'], new Date(), true),
    );
    await this.audit.record({
      actorId: me.id,
      action: 'USER_CREATED',
      entity: 'USER',
      entityId: saved.id,
      metadata: {
        reactivated: true,
        role: placement.role,
        departmentId: placement.department?.id ?? null,
      },
    });
    return UserMapper.toPublic(saved);
  }

  /** The organisation's shift, or a shared legacy one (no organisation). */
  private async shiftOf(org: string, shiftId: string): Promise<ShiftView> {
    const shift = await this.shifts.findById(shiftId);
    if (!shift || (shift.companyId && shift.companyId !== org)) {
      throw new NotFoundError('That shift does not exist in this organisation.', 'SHIFT_NOT_FOUND');
    }
    return shift;
  }

  private hm(value: string | undefined, fallback: string): string {
    const v = (value ?? '').trim();
    if (!v) return fallback;
    if (!HM.test(v)) throw new ValidationError('Shift times must be HH:MM (24-hour).');
    return v;
  }
}
