import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  DepartmentCount,
  PeopleQuery,
  PersonRole,
  ShiftPeopleReader,
  ShiftPerson,
} from '../domain/shift-people.reader';
import { departmentKey } from '../domain/shift.types';
import { isUuid } from './prisma-shift.repository';

const SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  department: true,
  designation: true,
  companyId: true,
  departmentId: true,
  managerId: true,
  status: true,
  deletedAt: true,
  role: { select: { name: true } },
} as const;

type Row = Prisma.UserGetPayload<{ select: typeof SELECT }>;

/** A user row as a ShiftPerson (exported for tests). */
export function toPerson(r: Row): ShiftPerson {
  return {
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    role: r.role.name as PersonRole,
    department: r.department,
    designation: r.designation,
    companyId: r.companyId,
    departmentId: r.departmentId,
    managerId: r.managerId,
    // A soft-deleted person can never approve anything, whatever their status says.
    active: r.status === 'ACTIVE' && r.deletedAt === null,
  };
}

@Injectable()
export class PrismaShiftPeopleReader implements ShiftPeopleReader {
  constructor(private readonly prisma: PrismaService) {}

  private where(q: PeopleQuery): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = { deletedAt: null, status: 'ACTIVE' };
    if (q.companyId) where.companyId = q.companyId;
    if (q.departmentIds) where.departmentId = { in: q.departmentIds.filter(isUuid) };
    if (q.roles) where.role = { name: { in: q.roles } };
    if (q.managerId) where.managerId = q.managerId;
    if (q.ids) where.id = { in: q.ids.filter(isUuid) };
    if (q.department) where.department = { equals: q.department.trim(), mode: 'insensitive' };
    if (q.search) {
      where.OR = [
        { firstName: { contains: q.search, mode: 'insensitive' } },
        { lastName: { contains: q.search, mode: 'insensitive' } },
        { email: { contains: q.search, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  async findById(id: string): Promise<ShiftPerson | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: SELECT,
    });
    return row ? toPerson(row) : null;
  }

  async findMany(q: PeopleQuery): Promise<ShiftPerson[]> {
    const rows = await this.prisma.user.findMany({
      where: this.where(q),
      select: SELECT,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      skip: q.skip,
      take: q.take,
    });
    return rows.map(toPerson);
  }

  async count(q: PeopleQuery): Promise<number> {
    return this.prisma.user.count({ where: this.where(q) });
  }

  async findAnyByIds(ids: string[]): Promise<ShiftPerson[]> {
    const wanted = [...new Set(ids)].filter(isUuid);
    if (!wanted.length) return [];
    const rows = await this.prisma.user.findMany({ where: { id: { in: wanted } }, select: SELECT });
    return rows.map(toPerson);
  }

  async listAllActive(): Promise<ShiftPerson[]> {
    const rows = await this.prisma.user.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      select: SELECT,
    });
    return rows.map(toPerson);
  }

  async listDepartments(companyId?: string): Promise<DepartmentCount[]> {
    const rows = await this.prisma.user.groupBy({
      by: ['department', 'companyId'],
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        department: { not: null },
        ...(companyId ? { companyId } : {}),
      },
      _count: { _all: true },
    });
    const merged = new Map<string, DepartmentCount>();
    for (const r of rows) {
      const key = departmentKey(r.department);
      if (!key || !r.department) continue;
      const mapKey = `${r.companyId ?? '-'}|${key}`;
      const existing = merged.get(mapKey);
      if (existing) existing.people += r._count._all;
      else
        merged.set(mapKey, {
          department: r.department.trim(),
          departmentKey: key,
          companyId: r.companyId,
          people: r._count._all,
        });
    }
    return [...merged.values()].sort((a, b) => a.department.localeCompare(b.department));
  }

  async listSuperAdminIds(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { deletedAt: null, status: 'ACTIVE', role: { name: 'SUPER_ADMIN' } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async listOrgAdminIds(companyId: string): Promise<string[]> {
    if (!isUuid(companyId)) return [];
    const rows = await this.prisma.user.findMany({
      where: { deletedAt: null, status: 'ACTIVE', companyId, role: { name: 'ADMIN' } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async listDepartmentManagerIds(departmentId: string): Promise<string[]> {
    if (!isUuid(departmentId)) return [];
    const rows = await this.prisma.managerDepartment.findMany({
      where: {
        departmentId,
        department: { deletedAt: null },
        manager: { deletedAt: null, status: 'ACTIVE', role: { name: 'MANAGER' } },
      },
      select: { managerId: true },
    });
    return rows.map((r) => r.managerId);
  }
}
