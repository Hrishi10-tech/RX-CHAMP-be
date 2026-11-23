import { Injectable } from '@nestjs/common';
import { AVATAR_COLUMNS, withEffectiveAvatar } from '@shared/avatars/person-avatar';
import { PrismaService } from '@shared/database/prisma.service';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { peopleWhere } from '@shared/tenancy';
import {
  PresenceContext,
  PresenceTeamReader,
  TeamMember,
} from '../domain/presence-team-reader.port';

@Injectable()
export class PrismaPresenceTeamReader implements PresenceTeamReader {
  constructor(private readonly prisma: PrismaService) {}

  async findReports(me: AuthenticatedUser): Promise<TeamMember[]> {
    const rows = await this.prisma.user.findMany({
      where: { AND: [peopleWhere(me), { status: 'ACTIVE' }] },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        department: true,
        ...AVATAR_COLUMNS,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    return rows.map(withEffectiveAvatar);
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
        ...AVATAR_COLUMNS,
        attendanceSource: true,
      },
    });
    if (!row) return null;
    const { managerId, attendanceSource, ...self } = withEffectiveAvatar(row);
    return {
      self,
      managerId: managerId ?? null,
      attendanceSource: attendanceSource === 'BIOMETRIC' ? 'BIOMETRIC' : 'AGENT',
    };
  }
}
