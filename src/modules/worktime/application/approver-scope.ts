import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { allOrgsInView, isAdminLike, managedDeptIds, orgOf, seesWholeOrg } from '@shared/tenancy';
import { ApprovalScope } from '../domain/approvals.reader';

/**
 * The approval items a person decides (docs/4.0/SPEC.md 1.3), or null when they
 * decide none (Staff):
 *  - Manager: Staff in their departments.
 *  - Admin / Super Admin: mine = waiting for the Admin or escalated; all = the organisation.
 *  - Super Manager: every item of the organisation (she is not the Admin's pool).
 *  - 3.3: a Super Manager or Super Admin on "All organisations": the same across
 *    every live organisation (ANY_ORG), or only `companyId`'s when asked.
 * `companyId` only narrows a combined view; inside one organisation it is ignored.
 */
export function approverScopeOf(
  me: AuthenticatedUser,
  scope: 'mine' | 'all' = 'mine',
  companyId?: string,
): ApprovalScope | null {
  if (allOrgsInView(me)) {
    return {
      kind: 'ANY_ORG',
      ...(companyId ? { companyId } : {}),
      adminMine: isAdminLike(me) && scope !== 'all',
      excludeUserId: me.id,
    };
  }
  const org = orgOf(me);
  if (!org) return null;
  if (me.role === Role.MANAGER) {
    return {
      kind: 'DEPTS',
      companyId: org,
      departmentIds: managedDeptIds(me),
      excludeUserId: me.id,
    };
  }
  if (!seesWholeOrg(me)) return null;
  return scope === 'all' || me.role === Role.SUPER_MANAGER
    ? { kind: 'ORG', companyId: org, excludeUserId: me.id }
    : { kind: 'ORG_ADMIN_MINE', companyId: org, excludeUserId: me.id };
}
