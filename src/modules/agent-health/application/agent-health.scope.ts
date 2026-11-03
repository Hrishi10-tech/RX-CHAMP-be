import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role, seesEveryOrg } from '@shared/rbac/roles.enum';
import {
  assertAnyGrant,
  isManager,
  managedDeptIds,
  orgInView,
  peopleWhere,
  peopleWhereAnyOrg,
  requireOrg,
  seesWholeOrg,
} from '@shared/tenancy/scope';

/** Filters GET /agent-health takes besides the caller (4.0). */
export interface AgentHealthScopeQuery {
  /** Super Admin or Super Manager: one organisation (else the one in view, or all). */
  companyId?: string;
  /** One department the caller may see. */
  departmentId?: string;
}

/**
 * Who may open the health page (4.0): Admins, Super Admins and the Super Manager;
 * a Manager only with at least one view grant, the rule every live-status view
 * follows (docs/4.0/SPEC.md 1.2). Staff never.
 */
export function assertCanSeeAgentHealth(me: AuthenticatedUser): void {
  if (seesWholeOrg(me) || seesEveryOrg(me.role)) return;
  if (isManager(me)) {
    assertAnyGrant(me);
    return;
  }
  throw new ForbiddenError('Only managers and admins can see agent health.');
}

/**
 * The organisation the page shows, or null for every organisation at once (a Super
 * Admin or the Super Manager with "All organisations" in view and no companyId).
 */
export function agentHealthOrg(me: AuthenticatedUser, q: AgentHealthScopeQuery): string | null {
  if (seesEveryOrg(me.role)) return q.companyId ?? orgInView(me);
  const org = requireOrg(me);
  // Someone else's organisation reads as unknown, never as forbidden.
  if (q.companyId && q.companyId !== org) throw new NotFoundError('Unknown organisation');
  return org;
}

/**
 * Prisma `where` on users for the health page (4.0 tenancy):
 *  - Manager: Staff of their departments (nobody without departments);
 *  - Admin: everyone in their organisation;
 *  - Super Admin / Super Manager: the organisation picked (X-Org-Id or companyId),
 *    or everyone in every live organisation.
 * Super Admins and the Super Manager are never listed (no agent tracks their day),
 * nor deleted or blocked people (their agent cannot call).
 */
export function agentHealthPeopleWhere(
  me: AuthenticatedUser,
  q: AgentHealthScopeQuery,
): Record<string, unknown> {
  // Refuses a companyId outside the caller's reach, and an unknown X-Org-Id.
  agentHealthOrg(me, q);
  let base: Record<string, unknown>;
  if (seesEveryOrg(me.role) && q.companyId) {
    // An organisation named in the query: only a live one (else nobody).
    base = peopleWhere({ ...me, orgId: q.companyId, orgHeaderInvalid: false, orgDeleted: false });
    base = { AND: [base, { company: { deletedAt: null } }] };
  } else {
    base = peopleWhereAnyOrg(me);
  }
  const and: Record<string, unknown>[] = [
    base,
    { status: 'ACTIVE', role: { name: { notIn: [Role.SUPER_ADMIN, Role.SUPER_MANAGER] } } },
  ];
  if (q.departmentId) {
    if (isManager(me) && !managedDeptIds(me).includes(q.departmentId)) {
      throw new NotFoundError('Unknown department');
    }
    // Admin-like callers: a department outside the organisation simply matches nobody.
    and.push({ departmentId: q.departmentId });
  }
  return { AND: and };
}
