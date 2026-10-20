import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { isId } from '@shared/validation/is-id';
import { DepartmentRef } from '../../domain/entities/user.entity';
import { DepartmentReader } from '../../domain/repositories/department-reader.port';

@Injectable()
export class PrismaDepartmentReader implements DepartmentReader {
  constructor(private readonly prisma: PrismaService) {}

  async findInOrg(companyId: string, ids: string[]): Promise<DepartmentRef[]> {
    const wanted = [...new Set(ids)].filter(isId);
    if (!wanted.length || !isId(companyId)) return [];
    return this.prisma.department.findMany({
      where: { id: { in: wanted }, companyId, deletedAt: null },
      select: { id: true, name: true, icon: true },
    });
  }
}
