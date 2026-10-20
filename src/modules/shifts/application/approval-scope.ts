import { ForbiddenError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { isAdminLike, managedDeptIds, requireOrg } from '@shared/tenancy';
import { ApprovalFilter } from '../domain/break-record.repository';

/** Admins, Super Admins (with an organisation) and Managers decide approvals. */
export function assertApprover(me: AuthenticatedUser): void {
  if (!isAdminLike(me) && me.role !== Role.MANAGER) {
    throw new ForbiddenError('Only managers and admins decide approvals.');
  }
  requireOrg(me);
}

/**
 * Which items an approvals list covers (docs/4.0/SPEC.md 1.3):
 *  - Manager: Staff in their departments (mine and all are the same).
 *  - Admin / Super Admin: mine = waiting for the Admin or escalated; all = the organisation.
 * Never the caller's own items.
 */
export function approvalFilterFor(
  me: AuthenticatedUser,
  scope: 'mine' | 'all' = 'mine',
): ApprovalFilter {
  const companyId = requireOrg(me);
  if (me.role === Role.MANAGER) {
    return {
      subjects: { companyId, departmentIds: managedDeptIds(me), roles: [Role.USER] },
      excludeUserId: me.id,
    };
  }
  return {
    subjects: { companyId },
    adminPool: scope !== 'all',
    excludeUserId: me.id,
  };
}
