import { Role } from '@shared/rbac/roles.enum';
import { UserStatus } from '@shared/types/user.types';
import { DepartmentRef, User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { PrismaUserWithRelations } from '../repositories/postgres-user.repository.types';

function ref(
  d: { id: string; name: string; icon: string; deletedAt: Date | null } | null | undefined,
): DepartmentRef | null {
  return d && d.deletedAt === null ? { id: d.id, name: d.name, icon: d.icon } : null;
}

export class UserPersistenceMapper {
  static toDomain(row: PrismaUserWithRelations): User {
    const role = row.role.name as Role;
    return User.fromPersistence({
      id: UserId.create(row.id),
      email: Email.create(row.email),
      passwordHash: row.passwordHash,
      firstName: row.firstName,
      lastName: row.lastName,
      designation: row.designation,
      role,
      department: row.department,
      managerId: row.managerId,
      companyId: row.companyId,
      companyName: row.company?.name ?? null,
      shiftId: row.shiftId,
      shiftStart: row.shiftStart,
      shiftEnd: row.shiftEnd,
      status: row.status as UserStatus,
      screenshotsEnabled: row.screenshotsEnabled,
      agentActivatedAt: row.agentActivatedAt,
      createdAt: row.createdAt,
      departmentId: row.departmentId,
      grantScreenshots: row.grantScreenshots,
      grantTimeline: row.grantTimeline,
      grantActivity: row.grantActivity,
      idleEnabled: row.idleEnabled,
      idleMinutes: row.idleMinutes,
      enrollVersion: row.enrollVersion,
      departmentRef: ref(row.departmentRef),
      managedDepartments:
        role === Role.MANAGER
          ? (row.managedDepartments ?? [])
              .map((m) => ref(m.department))
              .filter((d): d is DepartmentRef => d !== null)
              .sort((a, b) => a.name.localeCompare(b.name))
          : [],
    });
  }
}
