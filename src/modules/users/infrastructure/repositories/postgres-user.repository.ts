import { isId } from '@shared/validation/is-id';
import { Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { Role } from '@shared/rbac/roles.enum';
import { ConflictError } from '@shared/exceptions/app.exception';
import { PrismaService } from '@shared/database/prisma.service';
import { lockOrganisation, orgNotFound } from '@shared/database/org-lock';
import { User } from '../../domain/entities/user.entity';
import {
  CreateUserData,
  DEFAULT_USER_SORT,
  ListUsersFilter,
  UserRepository,
  UserSortOption,
} from '../../domain/repositories/user.repository';
import { UserPersistenceMapper } from '../mappers/user-persistence.mapper';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { UserWriteModel, WITH_RELATIONS } from './postgres-user.repository.types';

@Injectable()
export class PostgresUserRepository implements UserRepository {
  private roleIdCache = new Map<RoleName, string>();

  constructor(private readonly prisma: PrismaService) {}

  private get notDeleted() {
    return { deletedAt: null };
  }

  private async roleIdFor(role: Role): Promise<string> {
    const name = role as RoleName;
    const cached = this.roleIdCache.get(name);
    if (cached) return cached;
    const found = await this.prisma.role.findUniqueOrThrow({ where: { name } });
    this.roleIdCache.set(name, found.id);
    return found.id;
  }

  private buildWhere(filter: ListUsersFilter = {}): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = { ...this.notDeleted };
    if (filter.ids) where.id = { in: filter.ids };
    if (filter.department !== undefined) where.department = filter.department;
    if (filter.managerId) where.managerId = filter.managerId;
    if (filter.companyId) where.companyId = filter.companyId;
    if (filter.departmentIds) where.departmentId = { in: filter.departmentIds.filter(isId) };
    if (filter.role || filter.roles || filter.excludeRoles) {
      // `role` narrows `roles` (a caller's scope); it never widens it.
      const allowed = filter.role
        ? [filter.role].filter((r) => !filter.roles || filter.roles.includes(r))
        : filter.roles;
      where.role = {
        name: {
          ...(allowed ? { in: allowed as RoleName[] } : {}),
          ...(filter.excludeRoles ? { notIn: filter.excludeRoles as RoleName[] } : {}),
        },
      };
    }
    if (filter.status) where.status = filter.status;
    // Both bounds are whole days, resolved by the caller — see ListUsersUseCase.
    if (filter.joinedFrom || filter.joinedTo) {
      where.createdAt = {
        ...(filter.joinedFrom ? { gte: filter.joinedFrom } : {}),
        ...(filter.joinedTo ? { lte: filter.joinedTo } : {}),
      };
    }
    if (filter.search) {
      where.OR = [
        { firstName: { contains: filter.search, mode: 'insensitive' } },
        { lastName: { contains: filter.search, mode: 'insensitive' } },
        { email: { contains: filter.search, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async findById(id: string): Promise<User | null> {
    // A malformed id is simply nobody (Prisma would otherwise fail the uuid cast with a 500).
    if (!isId(id)) return null;
    const row = await this.prisma.user.findFirst({
      where: { id, ...this.notDeleted },
      include: WITH_RELATIONS,
    });
    return row ? UserPersistenceMapper.toDomain(row) : null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase().trim(), ...this.notDeleted },
      include: WITH_RELATIONS,
    });
    return row ? UserPersistenceMapper.toDomain(row) : null;
  }

  /**
   * Translates a sort option into Prisma ordering. Every option ends with `id` so
   * ties can't shuffle between pages (which would duplicate or skip rows).
   *
   * Note `role` is a Postgres enum, so the DB orders it by DECLARATION order
   * (SUPER_ADMIN, ADMIN, MANAGER, USER) — seniority, not the alphabet.
   */
  private buildOrderBy(
    sort: UserSortOption = DEFAULT_USER_SORT,
  ): Prisma.UserOrderByWithRelationInput[] {
    switch (sort) {
      case 'name_asc':
        return [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }];
      case 'name_desc':
        return [{ firstName: 'desc' }, { lastName: 'desc' }, { id: 'asc' }];
      case 'joined_asc':
        return [{ createdAt: 'asc' }, { id: 'asc' }];
      case 'role_asc':
        return [{ role: { name: 'asc' } }, { firstName: 'asc' }, { id: 'asc' }];
      case 'role_desc':
        return [{ role: { name: 'desc' } }, { firstName: 'asc' }, { id: 'asc' }];
      case 'joined_desc':
      default:
        return [{ createdAt: 'desc' }, { id: 'asc' }];
    }
  }

  async findAll(filter: ListUsersFilter = {}): Promise<User[]> {
    const rows = await this.prisma.user.findMany({
      where: this.buildWhere(filter),
      include: WITH_RELATIONS,
      orderBy: this.buildOrderBy(filter.sort),
      skip: filter.skip,
      take: filter.take,
    });
    return rows.map(UserPersistenceMapper.toDomain);
  }

  async findByManager(managerId: string, filter: ListUsersFilter = {}): Promise<User[]> {
    return this.findAll({ ...filter, managerId });
  }

  async count(filter: ListUsersFilter = {}): Promise<number> {
    return this.prisma.user.count({ where: this.buildWhere(filter) });
  }

  private async toColumns(u: UserWriteModel) {
    return {
      passwordHash: u.passwordHash,
      firstName: u.firstName,
      lastName: u.lastName,
      designation: u.designation,
      roleId: await this.roleIdFor(u.role),
      department: u.department,
      managerId: u.managerId,
      companyId: u.companyId,
      shiftId: u.shiftId,
      shiftStart: u.shiftStart,
      shiftEnd: u.shiftEnd,
      screenshotsEnabled: u.screenshotsEnabled,
      ...(u.departmentId !== undefined ? { departmentId: u.departmentId } : {}),
      ...(u.grants
        ? {
            grantScreenshots: u.grants.screenshots,
            grantTimeline: u.grants.timeline,
            grantActivity: u.grants.activity,
          }
        : {}),
      ...(u.idleEnabled !== undefined ? { idleEnabled: u.idleEnabled } : {}),
      ...(u.idleMinutes !== undefined ? { idleMinutes: u.idleMinutes } : {}),
    };
  }

  private emailClash(err: unknown, email: string): ConflictError | null {
    // `email` is globally unique and soft-deleted rows keep theirs, so the
    // caller's findByEmail check (which filters deletedAt) can miss a holder.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      this.targets(err, 'email')
    ) {
      return new ConflictError(`Email '${email}' is already in use`, 'EMAIL_IN_USE');
    }
    return null;
  }

  async create(data: CreateUserData): Promise<User> {
    const columns = await this.toColumns(data);
    const managed = [...new Set(data.managedDepartmentIds ?? [])].filter(isId);
    const row = await this.prisma
      .$transaction(async (tx) => {
        // 4.0: the organisation's row lock orders this against its deletion: a
        // deleted (or deleting) organisation takes nobody new (404 ORG_NOT_FOUND).
        if (data.companyId && !(await lockOrganisation(tx, data.companyId))) {
          throw orgNotFound();
        }
        const created = await tx.user.create({
          data: { email: data.email, ...columns },
          select: { id: true, companyId: true },
        });
        if (managed.length) {
          await tx.managerDepartment.createMany({
            data: managed.map((departmentId) => ({ managerId: created.id, departmentId })),
            skipDuplicates: true,
          });
        }
        // A shift chosen at creation is an explicit per-person assignment, so it
        // shows (and can be cleared) on the Assign Shifts screen like any other.
        if (data.shiftId) {
          await tx.shiftAssignment.create({
            data: {
              target: 'USER',
              userId: created.id,
              companyId: created.companyId,
              shiftId: data.shiftId,
              effectiveFrom: dateKeyInZone(new Date(), appTimezone()),
              createdById: data.createdById ?? null,
            },
          });
        }
        return tx.user.findUniqueOrThrow({ where: { id: created.id }, include: WITH_RELATIONS });
      })
      .catch((err: unknown) => {
        throw this.emailClash(err, data.email) ?? err;
      });
    return UserPersistenceMapper.toDomain(row);
  }

  async save(user: User): Promise<User> {
    const columns = await this.toColumns(user);
    const managed = user.managedDepartmentsToSave;
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { ...columns, email: user.email, status: user.status },
        });
        if (managed) {
          // Replace the set: one delete, one insert.
          await tx.managerDepartment.deleteMany({
            where: { managerId: user.id, departmentId: { notIn: managed } },
          });
          if (managed.length) {
            await tx.managerDepartment.createMany({
              data: managed.map((departmentId) => ({ managerId: user.id, departmentId })),
              skipDuplicates: true,
            });
          }
        }
        return tx.user.findUniqueOrThrow({ where: { id: user.id }, include: WITH_RELATIONS });
      });
      user.markSaved();
      return UserPersistenceMapper.toDomain(row);
    } catch (err) {
      throw this.emailClash(err, user.email) ?? err;
    }
  }

  async bumpEnrollVersion(id: string): Promise<number> {
    const row = await this.prisma.user.update({
      where: { id },
      data: { enrollVersion: { increment: 1 } },
      select: { enrollVersion: true },
    });
    return row.enrollVersion;
  }

  private targets(err: Prisma.PrismaClientKnownRequestError, field: string): boolean {
    const target = err.meta?.target;
    return Array.isArray(target) ? target.includes(field) : target === field;
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async markAgentActivatedIfFirst(id: string): Promise<boolean> {
    // Conditional update: only rows still null are touched, so exactly one
    // caller ever gets count === 1 even under concurrent enrollments.
    const res = await this.prisma.user.updateMany({
      where: { id, agentActivatedAt: null },
      data: { agentActivatedAt: new Date() },
    });
    return res.count > 0;
  }
}
