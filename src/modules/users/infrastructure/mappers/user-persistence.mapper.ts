import { Role } from '@shared/rbac/roles.enum';
import { UserStatus } from '@shared/types/user.types';
import { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { PrismaUserWithRelations } from '../repositories/postgres-user.repository.types';

export class UserPersistenceMapper {
  static toDomain(row: PrismaUserWithRelations): User {
    return User.fromPersistence({
      id: UserId.create(row.id),
      email: Email.create(row.email),
      passwordHash: row.passwordHash,
      firstName: row.firstName,
      lastName: row.lastName,
      designation: row.designation,
      role: row.role.name as Role,
      department: row.department,
      managerId: row.managerId,
      companyId: row.companyId,
      companyName: row.company?.name ?? null,
      shiftId: row.shiftId,
      shiftStart: row.shiftStart,
      shiftEnd: row.shiftEnd,
      status: row.status as UserStatus,
      createdAt: row.createdAt,
    });
  }
}
