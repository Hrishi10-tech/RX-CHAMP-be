import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
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
      },
    });
    return row ?? undefined;
  }

  async findReports(managerId: string): Promise<ActivityTeamMember[]> {
    const rows = await this.prisma.user.findMany({
      where: { managerId, status: 'ACTIVE', deletedAt: null },
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
