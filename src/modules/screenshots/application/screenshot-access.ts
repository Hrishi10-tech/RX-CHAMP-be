import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import { assertCanViewSection, isAdminLike, PersonFactsReader } from '@shared/tenancy';

/**
 * 4.0 (docs/4.0/SPEC.md 1.2, 2.2): viewing a person's screenshots needs the
 * screenshots grant for a Manager (always for an Admin or Super Admin in the
 * organisation). `change` (capture now, archive) is for admins only: a Manager's
 * grant is view-only. 404 outside scope.
 */
export async function assertCanAccess(
  me: AuthenticatedUser,
  targetUserId: string,
  facts: PersonFactsReader,
  change = false,
): Promise<void> {
  if (me.id === targetUserId && !change) return;
  assertCanViewSection(me, await facts.find(targetUserId), 'screenshots');
  if (change && !isAdminLike(me)) {
    throw new ForbiddenError('Only the organisation admin can capture or archive screenshots.');
  }
}
