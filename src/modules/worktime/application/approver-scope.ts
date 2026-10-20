import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { isAdminLike, managedDeptIds, orgOf } from '@shared/tenancy';
import { ApprovalScope } from '../domain/approvals.reader';

/**
 * The approval items a person decides (docs/4.0/SPEC.md 1.3), or null when they
 * decide none (Staff; a Super Admin with no organisation chosen):
 *  - Manager: Staff in their departments.
 *  - Admin / Super Admin: mine = waiting for the Admin or escalated; all = the organisation.
 */
export function approverScopeOf(
  me: AuthenticatedUser,
  scope: 'mine' | 'all' = 'mine',
): ApprovalScope | null {
  const companyId = orgOf(me);
  if (!companyId) return null;
  if (me.role === Role.MANAGER) {
    return { kind: 'DEPTS', companyId, departmentIds: managedDeptIds(me), excludeUserId: me.id };
  }
  if (!isAdminLike(me)) return null;
  return scope === 'all'
    ? { kind: 'ORG', companyId, excludeUserId: me.id }
    : { kind: 'ORG_ADMIN_MINE', companyId, excludeUserId: me.id };
}
