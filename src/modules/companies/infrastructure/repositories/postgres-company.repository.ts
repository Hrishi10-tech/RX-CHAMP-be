import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  CompanyRepository,
  CompanyWithStats,
  ListCompaniesFilter,
} from '../../domain/repositories/company.repository';

@Injectable()
export class PostgresCompanyRepository implements CompanyRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: ListCompaniesFilter = {}): Prisma.CompanyWhereInput {
    const where: Prisma.CompanyWhereInput = { deletedAt: null };
    if (filter.ids) where.id = { in: filter.ids };
    if (filter.search) {
      where.OR = [
        { name: { contains: filter.search, mode: 'insensitive' } },
        {
          users: {
            some: {
              deletedAt: null,
              role: { name: 'MANAGER' },
              OR: [
                { firstName: { contains: filter.search, mode: 'insensitive' } },
                { lastName: { contains: filter.search, mode: 'insensitive' } },
              ],
            },
          },
        },
      ];
    }
    return where;
  }

  async findAllWithStats(filter: ListCompaniesFilter = {}): Promise<CompanyWithStats[]> {
    const rows = await this.prisma.company.findMany({
      where: this.buildWhere(filter),
      orderBy: { createdAt: 'desc' },
      skip: filter.skip,
      take: filter.take,
      include: {
        _count: { select: { users: { where: { deletedAt: null } } } },
        users: {
          where: { deletedAt: null, role: { name: 'MANAGER' } },
          orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            managedDepartments: {
              where: { department: { deletedAt: null } },
              select: { departmentId: true },
            },
          },
        },
      },
    });

    // 4.0: a manager's people are the active Staff of their departments (one query).
    const deptIds = [
      ...new Set(
        rows.flatMap((r) =>
          r.users.flatMap((m) => m.managedDepartments.map((d) => d.departmentId)),
        ),
      ),
    ];
    const staff = deptIds.length
      ? await this.prisma.user.groupBy({
          by: ['departmentId'],
          where: {
            departmentId: { in: deptIds },
            deletedAt: null,
            status: 'ACTIVE',
            role: { name: 'USER' },
          },
          _count: { _all: true },
        })
      : [];
    const staffBy = new Map(staff.map((s) => [s.departmentId, s._count._all] as const));

    return rows.map((row) => {
      const managers = row.users.map((m) => ({
        id: m.id,
        email: m.email,
        name: `${m.firstName} ${m.lastName}`.trim(),
        userCount: m.managedDepartments.reduce((n, d) => n + (staffBy.get(d.departmentId) ?? 0), 0),
      }));
      return {
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        userCount: row._count.users,
        managerCount: managers.length,
        managers,
      };
    });
  }

  async count(filter: ListCompaniesFilter = {}): Promise<number> {
    return this.prisma.company.count({ where: this.buildWhere(filter) });
  }
}
