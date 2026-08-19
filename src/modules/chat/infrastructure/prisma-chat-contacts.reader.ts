import { Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { ChatContact, ChatContactsReader, ChatSender } from '../domain/chat-contacts.reader';

@Injectable()
export class PrismaChatContactsReader implements ChatContactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async findContacts(userId: string): Promise<ChatContact[]> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { managerId: true, role: { select: { name: true } } },
    });
    if (!me) return [];

    const rows = await this.prisma.user.findMany({
      where: {
        id: { not: userId },
        status: 'ACTIVE',
        deletedAt: null,
        ...this.scopeFor(userId, me.role.name, me.managerId),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        department: true,
        role: { select: { name: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });

    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      department: r.department,
      role: r.role.name,
    }));
  }

  async findSender(userId: string): Promise<ChatSender | undefined> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true },
    });
    return row ?? undefined;
  }

  /**
   * Who this user may message.
   *
   * Admins talk to managers. They sit outside the org chart — nobody manages them
   * and managers don't necessarily report to them — so scoping them to it left
   * them with an empty contact list.
   *
   * Everyone else is limited to their own line of the chart: the manager above
   * them, plus the reports below.
   */
  private scopeFor(
    userId: string,
    role: RoleName,
    managerId: string | null,
  ): Prisma.UserWhereInput {
    if (role === 'SUPER_ADMIN' || role === 'ADMIN') {
      return { role: { name: 'MANAGER' } };
    }

    return {
      OR: [...(managerId ? [{ id: managerId }] : []), { managerId: userId }],
    };
  }
}
