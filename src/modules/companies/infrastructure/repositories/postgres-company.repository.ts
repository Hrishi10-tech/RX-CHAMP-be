import { Injectable } from '@nestjs/common';
import { Company as PrismaCompany, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { PageFilter } from '@shared/types/pagination.types';
import {
  CompanyManagerStats,
  CompanyRecord,
  CompanyRepository,
  CompanyWithStats,
  CreateCompanyData,
  ListCompaniesFilter,
  ManagerUserRecord,
} from '../../domain/repositories/company.repository';

@Injectable()
export class PostgresCompanyRepository implements CompanyRepository {
  constructor(private readonly prisma: PrismaService) {}

  private buildWhere(filter: ListCompaniesFilter = {}): Prisma.CompanyWhereInput {
    const where: Prisma.CompanyWhereInput = { deletedAt: null };
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

  async findById(id: string): Promise<CompanyRecord | null> {
    const row = await this.prisma.company.findFirst({ where: { id, deletedAt: null } });
    return row ? this.toRecord(row) : null;
  }

  async findByName(name: string): Promise<CompanyRecord | null> {
    const row = await this.prisma.company.findFirst({ where: { name, deletedAt: null } });
    return row ? this.toRecord(row) : null;
  }

  async findAll(filter: ListCompaniesFilter = {}): Promise<CompanyRecord[]> {
    const rows = await this.prisma.company.findMany({
      where: this.buildWhere(filter),
      orderBy: { createdAt: 'desc' },
      skip: filter.skip,
      take: filter.take,
    });
    return rows.map((r) => this.toRecord(r));
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
            _count: { select: { reports: { where: { deletedAt: null } } } },
          },
        },
      },
    });

    return rows.map((row) => {
      const managers: CompanyManagerStats[] = row.users.map((m) => ({
        id: m.id,
        email: m.email,
        name: `${m.firstName} ${m.lastName}`.trim(),
        userCount: m._count.reports,
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

  async findManagerUsers(
    companyId: string,
    managerId: string,
    page: PageFilter = {},
  ): Promise<ManagerUserRecord[]> {
    const rows = await this.prisma.user.findMany({
      where: { deletedAt: null, companyId, managerId },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      skip: page.skip,
      take: page.take,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        designation: true,
        role: { select: { name: true } },
      },
    });
    return rows.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      role: u.designation ?? u.role.name,
    }));
  }

  async countManagerUsers(companyId: string, managerId: string): Promise<number> {
    return this.prisma.user.count({ where: { deletedAt: null, companyId, managerId } });
  }

  async create(data: CreateCompanyData): Promise<CompanyRecord> {
    const row = await this.prisma.company.create({ data: { name: data.name } });
    return this.toRecord(row);
  }

  private toRecord(row: PrismaCompany): CompanyRecord {
    return { id: row.id, name: row.name, createdAt: row.createdAt };
  }
}
