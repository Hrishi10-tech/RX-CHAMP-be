import { Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { Role } from '@shared/rbac/roles.enum';
import { ConflictError } from '@shared/exceptions/app.exception';
import { PrismaService } from '@shared/database/prisma.service';
import { User } from '../../domain/entities/user.entity';
import {
  CreateUserData,
  DEFAULT_USER_SORT,
  ListUsersFilter,
  UserRepository,
  UserSortOption,
} from '../../domain/repositories/user.repository';
import { UserPersistenceMapper } from '../mappers/user-persistence.mapper';
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
    if (filter.role) where.role = { name: filter.role as RoleName };
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
    };
  }

  async create(data: CreateUserData): Promise<User> {
    const row = await this.prisma.user.create({
      data: { email: data.email, ...(await this.toColumns(data)) },
      include: WITH_RELATIONS,
    });
    return UserPersistenceMapper.toDomain(row);
  }

  async save(user: User): Promise<User> {
    try {
      const row = await this.prisma.user.update({
        where: { id: user.id },
        data: { ...(await this.toColumns(user)), email: user.email, status: user.status },
        include: WITH_RELATIONS,
      });
      return UserPersistenceMapper.toDomain(row);
    } catch (err) {
      // `email` is globally unique and soft-deleted rows keep theirs, so the
      // caller's findByEmail check (which filters deletedAt) can miss a holder.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        this.targets(err, 'email')
      ) {
        throw new ConflictError(`Email '${user.email}' is already in use`);
      }
      throw err;
    }
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
