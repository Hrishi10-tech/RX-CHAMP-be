import { Injectable } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { ChatContact, ChatContactsReader, ChatSender } from '../domain/chat-contacts.reader';

@Injectable()
export class PrismaChatContactsReader implements ChatContactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async findContacts(userId: string): Promise<ChatContact[]> {
    const me = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
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
        managerId: true,
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
      relation: r.id === me.managerId ? 'MANAGER' : r.managerId === userId ? 'REPORT' : 'ORG',
    }));
  }

  async canMessage(fromUserId: string, toUserId: string): Promise<boolean> {
    if (fromUserId === toUserId) return false;
    const contacts = await this.findContacts(fromUserId);
    return contacts.some((c) => c.id === toUserId);
  }

  async findSender(userId: string): Promise<ChatSender | undefined> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true },
    });
    return row ?? undefined;
  }

  /**
   * Who this user may message: their own line of the chart, the manager above
   * them and the reports below. A Super Admin additionally reaches every Manager,
   * since Managers whose reporting line was never set would otherwise be unreachable.
   */
  private scopeFor(
    userId: string,
    role: RoleName,
    managerId: string | null,
  ): Prisma.UserWhereInput {
    const line: Prisma.UserWhereInput[] = [
      ...(managerId ? [{ id: managerId }] : []),
      { managerId: userId },
    ];
    if (role === 'SUPER_ADMIN') line.push({ role: { name: 'MANAGER' } });
    return { OR: line };
  }
}
