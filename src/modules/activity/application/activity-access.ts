import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { assertCanViewSection, PersonFactsReader, Section } from '@shared/tenancy';

/**
 * 4.0 (docs/4.0/SPEC.md 1.2, 2.2): a person's own activity, anyone in the
 * organisation for an Admin or Super Admin, Staff in their departments for a
 * Manager with the grant for this section. 404 outside scope, 403 GRANT_REQUIRED
 * without the grant.
 */
export async function assertCanAccess(
  me: AuthenticatedUser,
  targetUserId: string,
  facts: PersonFactsReader,
  section: Section = 'activity',
): Promise<void> {
  if (me.id === targetUserId) return;
  assertCanViewSection(me, await facts.find(targetUserId), section);
}
