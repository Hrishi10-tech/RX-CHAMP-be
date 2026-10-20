import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { PersonFacts } from './scope';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The organisation, department and role of people, for scope checks in modules
 * that do not otherwise read users (activity, screenshots, analytics, presence).
 * Deleted people are not found.
 */
@Injectable()
export class PersonFactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async find(userId: string): Promise<PersonFacts | null> {
    if (!UUID.test(userId)) return null;
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true, companyId: true, departmentId: true, role: { select: { name: true } } },
    });
    return row
      ? {
          id: row.id,
          companyId: row.companyId,
          departmentId: row.departmentId,
          role: row.role.name,
        }
      : null;
  }
}
