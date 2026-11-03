import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role, seesEveryOrg } from '@shared/rbac/roles.enum';
import { grantsOf, hasAnyGrant, isAdminLike, orgOf } from '@shared/tenancy';
import { MePermissions, MeView } from '../user.types';

/** The menus the portal may show (docs/4.0/SPEC.md 1.2 and 7.1), from the caller alone. */
export function permissionsOf(me: AuthenticatedUser): MePermissions {
  const org = orgOf(me);
  const adminInOrg = isAdminLike(me) && !!org && !me.orgHeaderInvalid;
  const manager = me.role === Role.MANAGER && !!org;
  // 3.3: the Super Manager sees and decides like an Admin but administers nothing.
  const superManager = me.role === Role.SUPER_MANAGER && !!org && !me.orgHeaderInvalid;
  const overseer = adminInOrg || superManager;
  const grants = org ? grantsOf(me) : { screenshots: false, timeline: false, activity: false };
  return {
    canManageOrganisations: me.role === Role.SUPER_ADMIN,
    canManageOrg: adminInOrg,
    canManagePeople: overseer,
    canManageDepartments: adminInOrg,
    canManageShifts: adminInOrg,
    canSeeTeam: overseer || (manager && hasAnyGrant(me)),
    canSeeScreenshots: (overseer || manager) && grants.screenshots,
    canSeeTimeline: (overseer || manager) && grants.timeline,
    canSeeActivity: (overseer || manager) && grants.activity,
    canApprove: overseer || manager,
    canSeeReports: overseer || manager,
    canSeeTeamBreaks: overseer || manager,
    canUseMessages: overseer || manager,
    canUsePortal: me.role !== Role.USER,
    needsOrganisation: seesEveryOrg(me.role) && !org,
    isSuperManager: me.role === Role.SUPER_MANAGER,
    canAdjustFocus: me.role === Role.SUPER_MANAGER,
    canSeeAgentHealth: overseer || (manager && hasAnyGrant(me)) || seesEveryOrg(me.role),
  };
}

/**
 * GET /me: who is signed in, the organisation they act in (a Super Admin: the one
 * chosen with X-Org-Id), their department(s), grants and menu permissions. Two
 * small queries at most; the portal reads it on every load, never cached.
 */
@Injectable()
export class GetMeUseCase {
  constructor(private readonly prisma: PrismaService) {}

  async execute(me: AuthenticatedUser): Promise<MeView> {
    const row = await this.prisma.user.findFirst({
      where: { id: me.id, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: { select: { name: true } },
        company: { select: { id: true, name: true, deletedAt: true } },
        departmentRef: { select: { id: true, name: true, icon: true, deletedAt: true } },
        managedDepartments: {
          where: { department: { deletedAt: null } },
          select: { department: { select: { id: true, name: true, icon: true } } },
        },
      },
    });
    if (!row) throw new NotFoundError('Unknown user');

    const role = row.role.name as Role;
    const orgId = me.orgHeaderInvalid ? null : orgOf(me);
    let organisation: MeView['organisation'] = null;
    if (orgId) {
      if (row.company && row.company.id === orgId && row.company.deletedAt === null) {
        organisation = { id: row.company.id, name: row.company.name };
      } else {
        const org = await this.prisma.company.findFirst({
          where: { id: orgId, deletedAt: null },
          select: { id: true, name: true },
        });
        organisation = org ?? null;
      }
    }

    const dept =
      row.departmentRef && row.departmentRef.deletedAt === null ? row.departmentRef : null;
    const grants = organisation
      ? grantsOf(me)
      : { screenshots: false, timeline: false, activity: false };
    return {
      id: row.id,
      name: `${row.firstName} ${row.lastName}`.trim(),
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
      role,
      organisation,
      department: dept ? { id: dept.id, name: dept.name, icon: dept.icon } : null,
      departments:
        role === Role.MANAGER
          ? row.managedDepartments
              .map((m) => m.department)
              .sort((a, b) => a.name.localeCompare(b.name))
          : [],
      grants:
        role === Role.USER ? { screenshots: false, timeline: false, activity: false } : grants,
      permissions: permissionsOf(organisation ? me : { ...me, orgId: null, companyId: null }),
    };
  }
}
