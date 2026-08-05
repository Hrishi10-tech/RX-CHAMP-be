
import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Permission } from '@shared/rbac/permissions.enum';
import { Role } from '@shared/rbac/roles.enum';
import { AuthUserReader } from '../domain/auth-user-reader.port';

@Injectable()
export class PrismaAuthUserReader implements AuthUserReader {
  constructor(private readonly prisma: PrismaService) {}

  async loadById(id: string): Promise<AuthenticatedUser | null> {
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { role: true },
    });
    if (!row) return null;

    return {
      id: row.id,
      email: row.email,
      role: row.role.name as Role,
      permissions: row.role.permissions as Permission[],
      department: row.department,
      companyId: row.companyId,
      status: row.status,
    };
  }
}
