
import { Injectable } from '@nestjs/common';
import { Role as PrismaRole, RoleName } from '@prisma/client';
import { Role } from '@shared/rbac/roles.enum';
import { PrismaService } from '@shared/database/prisma.service';
import {
  CreateRoleData,
  RoleRecord,
  RoleRepository,
} from '../../domain/repositories/role.repository';

@Injectable()
export class PostgresRoleRepository implements RoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByName(name: Role): Promise<RoleRecord | null> {
    const row = await this.prisma.role.findUnique({
      where: { name: name as RoleName },
    });
    return row ? this.toRecord(row) : null;
  }

  async create(data: CreateRoleData): Promise<RoleRecord> {
    const row = await this.prisma.role.create({
      data: {
        name: data.name as RoleName,
        permissions: data.permissionCodes,
      },
    });
    return this.toRecord(row);
  }

  private toRecord(row: PrismaRole): RoleRecord {
    return {
      id: row.id,
      name: row.name,
      permissions: row.permissions,
      createdAt: row.createdAt,
    };
  }
}
