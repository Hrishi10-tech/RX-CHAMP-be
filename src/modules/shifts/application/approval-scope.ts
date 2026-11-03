import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import {
  allOrgsInView,
  isAdminLike,
  managedDeptIds,
  requireOrg,
  seesWholeOrg,
} from '@shared/tenancy';
import { ApprovalFilter } from '../domain/break-record.repository';

/**
 * Admins, Super Admins and the Super Manager (with an organisation, or 3.3 on
 * "All organisations") and Managers decide approvals.
 */
export function assertApprover(me: AuthenticatedUser): void {
  if (!seesWholeOrg(me) && me.role !== Role.MANAGER) {
    throw new ForbiddenError('Only managers and admins decide approvals.');
  }
  if (!allOrgsInView(me)) requireOrg(me);
}

/**
 * Which items an approvals list covers (docs/4.0/SPEC.md 1.3):
 *  - Manager: Staff in their departments (mine and all are the same).
 *  - Admin / Super Admin: mine = waiting for the Admin or escalated; all = the organisation.
 *  - Super Manager: every item of the organisation.
 *  - 3.3 "All organisations" (Super Manager, Super Admin): the same over every live
 *    organisation, or only `companyId`'s.
 * Never the caller's own items.
 */
export function approvalFilterFor(
  me: AuthenticatedUser,
  scope: 'mine' | 'all' = 'mine',
  companyId?: string,
): ApprovalFilter {
  if (allOrgsInView(me)) {
    return {
      subjects: { ...(companyId ? { companyId } : {}), liveOrgsOnly: true },
      adminPool: isAdminLike(me) && scope !== 'all',
      excludeUserId: me.id,
    };
  }
  const org = requireOrg(me);
  if (companyId && companyId !== org) {
    throw new NotFoundError('That organisation does not exist.', 'ORG_NOT_FOUND');
  }
  if (me.role === Role.MANAGER) {
    return {
      subjects: { companyId: org, departmentIds: managedDeptIds(me), roles: [Role.USER] },
      excludeUserId: me.id,
    };
  }
  return {
    subjects: { companyId: org },
    // The Super Manager is not the Admin's pool: she sees every item of the organisation.
    adminPool: scope !== 'all' && me.role !== Role.SUPER_MANAGER,
    excludeUserId: me.id,
  };
}
