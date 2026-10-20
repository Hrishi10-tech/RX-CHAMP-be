import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { managedDeptIds, orgOf } from '@shared/tenancy';
import { isId } from '@shared/validation/is-id';
import {
  ChatContact,
  ChatContactsReader,
  ChatRelation,
  ChatSender,
} from '../domain/chat-contacts.reader';

/**
 * Who may message whom (docs/4.0/SPEC.md 1.2, Messages), inside one organisation:
 *  - Admin: everyone in their organisation, and the Super Admins (so they can reply);
 *  - Manager: the Staff of their departments and the organisation's Admin;
 *  - Staff: the managers of their department and the organisation's Admin;
 *  - Super Admin: the Admin of the organisation they have selected (X-Org-Id).
 */
export function contactsWhere(me: AuthenticatedUser): Prisma.UserWhereInput | null {
  const org = orgOf(me);
  if (!org) return null;
  const inOrg = { companyId: org };
  const admins: Prisma.UserWhereInput = { ...inOrg, role: { name: 'ADMIN' } };
  switch (me.role) {
    case Role.SUPER_ADMIN:
      return admins;
    case Role.ADMIN:
      return {
        OR: [
          { ...inOrg, role: { name: { not: 'SUPER_ADMIN' } } },
          { role: { name: 'SUPER_ADMIN' } },
        ],
      };
    case Role.MANAGER: {
      const depts = managedDeptIds(me).filter(isId);
      return {
        OR: [
          admins,
          ...(depts.length
            ? [{ ...inOrg, role: { name: 'USER' as const }, departmentId: { in: depts } }]
            : []),
        ],
      };
    }
    case Role.USER: {
      const dept = me.departmentId && isId(me.departmentId) ? me.departmentId : null;
      return {
        OR: [
          admins,
          ...(dept
            ? [
                {
                  ...inOrg,
                  role: { name: 'MANAGER' as const },
                  managedDepartments: {
                    some: { departmentId: dept, department: { deletedAt: null } },
                  },
                },
              ]
            : []),
        ],
      };
    }
    default:
      return null;
  }
}

/** How `role` relates to someone with `mine` (see ChatRelation). */
export function relationOf(mine: Role, theirs: string): ChatRelation {
  if (mine === Role.USER) return theirs === 'MANAGER' ? 'MANAGER' : 'ORG';
  if (mine === Role.MANAGER)
    return theirs === 'USER' ? 'REPORT' : theirs === 'ADMIN' ? 'MANAGER' : 'ORG';
  if (mine === Role.ADMIN) return theirs === 'SUPER_ADMIN' ? 'MANAGER' : 'REPORT';
  if (mine === Role.SUPER_ADMIN) return 'REPORT';
  return 'ORG';
}

@Injectable()
export class PrismaChatContactsReader implements ChatContactsReader {
  constructor(private readonly prisma: PrismaService) {}

  async findContacts(me: AuthenticatedUser): Promise<ChatContact[]> {
    const scope = contactsWhere(me);
    if (!scope) return [];
    const rows = await this.prisma.user.findMany({
      where: { AND: [scope, { id: { not: me.id }, status: 'ACTIVE', deletedAt: null }] },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        department: true,
        role: { select: { name: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      department: r.department,
      role: r.role.name,
      relation: relationOf(me.role, r.role.name),
    }));
  }

  async canMessage(me: AuthenticatedUser, toUserId: string): Promise<boolean> {
    if (toUserId === me.id || !isId(toUserId)) return false;
    const scope = contactsWhere(me);
    if (!scope) return false;
    const row = await this.prisma.user.findFirst({
      where: { AND: [scope, { id: toUserId, status: 'ACTIVE', deletedAt: null }] },
      select: { id: true },
    });
    return row !== null;
  }

  async findSender(userId: string): Promise<ChatSender | undefined> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstName: true, lastName: true },
    });
    return row ?? undefined;
  }
}
