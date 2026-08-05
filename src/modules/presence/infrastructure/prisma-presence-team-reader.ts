import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import {
  PresenceContext,
  PresenceTeamReader,
  TeamMember,
} from '../domain/presence-team-reader.port';

@Injectable()
export class PrismaPresenceTeamReader implements PresenceTeamReader {
  constructor(private readonly prisma: PrismaService) {}

  async findReports(managerId: string): Promise<TeamMember[]> {
    return this.prisma.user.findMany({
      where: { managerId, status: 'ACTIVE', deletedAt: null },
      select: { id: true, firstName: true, lastName: true, email: true, department: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
  }

  async findContext(userId: string): Promise<PresenceContext | null> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        department: true,
        managerId: true,
      },
    });
    if (!row) return null;
    const { managerId, ...self } = row;
    return { self, managerId: managerId ?? null };
  }
}
