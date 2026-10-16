import { Inject, Injectable } from '@nestjs/common';
import { ROLE_LABEL, Role, outranks } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { UserCreatedEvent } from '../../domain/events/user-created.event';
import { UserAccessService } from '../../domain/services/user-access.service';
import { User } from '../../domain/entities/user.entity';
import { UserMapper } from '../mappers/user.mapper';
import { CreateUsersResult, PublicUser } from '../user.types';
import {
  CreateUserData,
  USER_REPOSITORY,
  UserRepository,
} from '../../domain/repositories/user.repository';
import { SHIFT_READER, ShiftReader, ShiftView } from '../../domain/repositories/shift-reader.port';
import { ROLE_READER, RoleReader } from '../../domain/repositories/role-reader.port';
import { CreateUserItemDto } from '../dto';
import { MIN_PASSWORD_LENGTH } from '../user.constants';

type RowError = string;

/**
 * Creates one or many users. Partial success: every row either lands in
 * `created` or produces an entry in `errors`; one bad row never fails the batch.
 *
 * Hierarchy rules (Super Admin -> Manager -> Staff):
 *  - a Super Admin may create any role, choose the company, and choose who the
 *    new person reports to (defaults to themselves);
 *  - a Manager may create Staff only; the new person reports to them and joins
 *    their company;
 *  - Staff may not create anyone.
 *
 * Re-adding an email whose account was disabled reactivates it, but only for a
 * caller who could have created that account in the first place: a Super Admin,
 * or the Manager who already owns that staff member (or nobody does). The new
 * password replaces the old one, so a reactivated account never comes back with
 * credentials its owner may have shared.
 */
@Injectable()
export class CreateUsersUseCase {
  private readonly access = new UserAccessService();
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SHIFT_READER) private readonly shifts: ShiftReader,
    @Inject(ROLE_READER) private readonly roles: RoleReader,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async execute(me: AuthenticatedUser, incoming: CreateUserItemDto[]): Promise<CreateUsersResult> {
    this.access.assertCanCreate(me);
    const created: PublicUser[] = [];
    const errors: CreateUsersResult['errors'] = [];
    for (const row of incoming) {
      const email = (row.email ?? '').toLowerCase().trim();
      try {
        const result = await this.createOne(me, row, email);
        if (typeof result === 'string') errors.push({ email, error: result });
        else created.push(result);
      } catch (err) {
        errors.push({ email, error: (err as Error).message || 'could not create user' });
      }
    }
    return { created, errors };
  }

  private async createOne(
    me: AuthenticatedUser,
    row: CreateUserItemDto,
    email: string,
  ): Promise<PublicUser | RowError> {
    const firstName = (row.firstName ?? '').trim();
    const lastName = (row.lastName ?? '').trim();
    const password = (row.password ?? '').trim();
    const roleName = (row.role ?? '').trim() as Role;

    if (!firstName || !lastName || !email || !password || !roleName) {
      return 'first name, last name, email, password and role are required';
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    }

    const roleView = await this.roles.findByName(roleName);
    if (!roleView) return `unknown role '${roleName}'`;
    if (!this.access.canAssignRole(me, roleView.name)) {
      return me.role === Role.MANAGER
        ? 'managers can only create staff'
        : `you cannot create a ${ROLE_LABEL[roleView.name]}`;
    }

    const managerId = await this.resolveManager(me, row.managerId);
    if (typeof managerId !== 'string' && managerId !== null) return managerId.error;

    const companyId = await this.resolveCompany(me, row.companyId);
    if (companyId && typeof companyId !== 'string') return companyId.error;

    let shift: ShiftView | null = null;
    if (row.shiftId) {
      shift = await this.shifts.findById(row.shiftId);
      if (!shift) return 'unknown shift';
      // A company's shift is for that company's people only.
      if (shift.companyId && companyId && shift.companyId !== companyId) {
        return 'that shift belongs to another company';
      }
    }

    const existing = await this.users.findByEmail(email);
    if (existing) {
      if (existing.isActive()) return 'email already exists';
      return this.reactivate(me, existing, row, roleView.name, password, managerId);
    }

    const passwordHash = await this.hasher.hash(password);
    const data: CreateUserData = {
      email,
      passwordHash,
      firstName,
      lastName,
      role: roleView.name,
      designation: (row.designation ?? '').trim() || undefined,
      department: (row.department ?? '').trim() || me.department || undefined,
      managerId: managerId ?? undefined,
      companyId: (companyId as string | null) ?? shift?.companyId ?? undefined,
      shiftId: shift?.id,
      shiftStart: shift ? shift.start : (row.shiftStart ?? '10:00').trim(),
      shiftEnd: shift ? shift.end : (row.shiftEnd ?? '19:00').trim(),
      createdById: me.id,
    };
    const user = await this.users.create(data);

    await this.events.publish(
      UserCreatedEvent.eventName,
      new UserCreatedEvent(user.id, user.email, user.role, me.id, new Date()),
    );
    return UserMapper.toPublic(user);
  }

  private async reactivate(
    me: AuthenticatedUser,
    existing: User,
    row: CreateUserItemDto,
    role: Role,
    password: string,
    managerId: string | null,
  ): Promise<PublicUser | RowError> {
    const allowed =
      me.role === Role.SUPER_ADMIN ||
      (me.role === Role.MANAGER &&
        outranks(me.role, existing.role) &&
        (existing.managerId === me.id || existing.managerId === null) &&
        // ...and only within their own company.
        (existing.companyId === null || existing.companyId === (me.companyId ?? null)));
    // Same message as an active duplicate: whether an address belongs to a
    // disabled account outside your reach is not yours to learn.
    if (!allowed) return 'email already exists';

    existing.reactivateWith(
      (row.firstName ?? '').trim(),
      (row.lastName ?? '').trim(),
      row.designation ?? null,
    );
    existing.changeRole(role);
    existing.setPasswordHash(await this.hasher.hash(password));
    if (me.role === Role.MANAGER) existing.assignManager(me.id);
    else if (row.managerId !== undefined) existing.assignManager(managerId);
    if (row.department !== undefined) existing.setDepartment(row.department);

    const saved = await this.users.save(existing);
    return UserMapper.toPublic(saved);
  }

  /** Who the new person reports to. Managers: always themselves. */
  private async resolveManager(
    me: AuthenticatedUser,
    requested: string | undefined,
  ): Promise<string | null | { error: string }> {
    if (me.role !== Role.SUPER_ADMIN || !requested) return me.id;
    const manager = await this.users.findById(requested);
    if (!manager || !manager.isActive()) return { error: 'unknown manager' };
    if (manager.role === Role.USER) return { error: 'staff cannot have reports' };
    return manager.id;
  }

  /** Company: Super Admin may choose an existing one; Managers use their own. */
  private async resolveCompany(
    me: AuthenticatedUser,
    requested: string | undefined,
  ): Promise<string | null | { error: string }> {
    if (me.role !== Role.SUPER_ADMIN) return me.companyId ?? null;
    if (!requested) return me.companyId ?? null;
    if (!(await this.shifts.companyExists(requested))) return { error: 'unknown company' };
    return requested;
  }
}
