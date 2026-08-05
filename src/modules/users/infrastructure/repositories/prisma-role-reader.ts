
import { Injectable } from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { Role } from '@shared/rbac/roles.enum';
import { RoleReader, RoleView } from '../../domain/repositories/role-reader.port';

@Injectable()
export class PrismaRoleReader implements RoleReader {
  constructor(private readonly prisma: PrismaService) {}

  async findByName(name: Role): Promise<RoleView | null> {
    const r = await this.prisma.role.findUnique({ where: { name: name as RoleName } });
    return r ? { id: r.id, name: r.name as Role } : null;
  }
}

