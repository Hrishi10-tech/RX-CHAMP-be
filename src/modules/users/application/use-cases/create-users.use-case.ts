import { Inject, Injectable } from '@nestjs/common';
import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { PASSWORD_HASHER, PasswordHasher } from '@shared/security/password-hasher.port';
import { UserCreatedEvent } from '../../domain/events/user-created.event';
import { UserAccessService } from '../../domain/services/user-access.service';
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
      const firstName = (row.firstName ?? '').trim();
      const lastName = (row.lastName ?? '').trim();
      const password = (row.password ?? '').trim();
      const roleName = (row.role ?? '').trim() as Role;

      if (!firstName || !lastName || !email || !password || !roleName) {
        errors.push({
          email,
          error: 'first name, last name, email, password and role are required',
        });
        continue;
      }

      const existing = await this.users.findByEmail(email);
      if (existing) {
        if (!existing.isActive()) {
          existing.reactivateWith(firstName, lastName, row.designation ?? null);

          existing.assignManager(me.id);
          const saved = await this.users.save(existing);
          created.push(UserMapper.toPublic(saved));
        } else {
          errors.push({ email, error: 'email already exists' });
        }
        continue;
      }

      const roleView = await this.roles.findByName(roleName);
      if (!roleView) {
        errors.push({ email, error: `unknown role '${roleName}'` });
        continue;
      }

      if (me.role === Role.MANAGER && roleView.name !== Role.USER) {
        errors.push({ email, error: 'managers can only create members' });
        continue;
      }

      const shift = row.shiftId ? await this.shifts.findById(row.shiftId) : null;
      const passwordHash = await this.hasher.hash(password);
      const user = await this.users.create(
        this.toCreateData(row, me, roleView.name, passwordHash, shift),
      );

      created.push(UserMapper.toPublic(user));
      await this.events.publish(
        UserCreatedEvent.eventName,
        new UserCreatedEvent(user.id, user.email, user.role, me.id, new Date()),
      );
    }

    return { created, errors };
  }

  private toCreateData(
    row: CreateUserItemDto,
    me: AuthenticatedUser,
    role: Role,
    passwordHash: string,
    shift: ShiftView | null,
  ): CreateUserData {
    const fallbackCompany = me.role === Role.MANAGER ? me.companyId : row.companyId;
    return {
      email: (row.email ?? '').toLowerCase().trim(),
      passwordHash,
      firstName: (row.firstName ?? '').trim(),
      lastName: (row.lastName ?? '').trim(),
      role,
      designation: (row.designation ?? '').trim() || undefined,
      department: row.department ?? me.department ?? undefined,
      managerId: me.id,
      companyId: shift?.companyId ?? fallbackCompany ?? undefined,
      shiftId: shift?.id,
      shiftStart: shift ? shift.start : (row.shiftStart ?? '10:00').trim(),
      shiftEnd: shift ? shift.end : (row.shiftEnd ?? '19:00').trim(),
    };
  }
}
