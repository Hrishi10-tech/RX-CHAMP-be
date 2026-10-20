import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { peopleWhere } from '@shared/tenancy';
import {
  ActivityAccessReader,
  ActivitySelf,
  ActivityTeamMember,
} from '../domain/activity-access.reader';

@Injectable()
export class PrismaActivityAccessReader implements ActivityAccessReader {
  constructor(private readonly prisma: PrismaService) {}

  async findManagerId(userId: string): Promise<string | null | undefined> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { managerId: true },
    });
    return row ? row.managerId : undefined;
  }

  async findSelf(userId: string): Promise<ActivitySelf | undefined> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        department: true,
        managerId: true,
        screenshotsEnabled: true,
        role: { select: { name: true } },
      },
    });
    if (!row) return undefined;
    const { role, ...rest } = row;
    return { ...rest, role: role.name };
  }

  async findReports(me: AuthenticatedUser): Promise<ActivityTeamMember[]> {
    const rows = await this.prisma.user.findMany({
      where: { AND: [peopleWhere(me), { status: 'ACTIVE' }] },
      select: { id: true, firstName: true, lastName: true, email: true, department: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      department: r.department,
    }));
  }
}
