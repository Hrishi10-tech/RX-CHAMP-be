import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { seesEveryOrg } from '@shared/rbac/roles.enum';

/**
 * 3.3 combined views ("All organisations") for the Super Manager and the Super
 * Admin, on top of 4.0's one-organisation rules.
 *
 * 4.0 computes everything per organisation (settings, calendars, month locks), so a
 * combined list is built by running the one-organisation code once per live
 * organisation, each time acting in that organisation (actingIn), and concatenating
 * the answers grouped by organisation. Every scope rule (canSeePerson, approval
 * routing) then applies unchanged inside each organisation.
 */

/** An organisation as combined views name it. */
export interface OrgRef {
  id: string;
  name: string;
}

/**
 * True when a Super Manager or Super Admin has no organisation picked (X-Org-Id
 * absent): "All organisations". False for an invalid X-Org-Id (it answers 404).
 */
export function allOrgsInView(me: AuthenticatedUser): boolean {
  return seesEveryOrg(me.role) && !me.orgHeaderInvalid && !me.orgId;
}

/**
 * The same caller acting in one organisation, as if it had been picked with
 * X-Org-Id. Only for callers that see every organisation (others are returned as
 * they are, so their scope can never widen).
 */
export function actingIn(me: AuthenticatedUser, companyId: string): AuthenticatedUser {
  if (!seesEveryOrg(me.role)) return me;
  return { ...me, orgId: companyId, orgHeaderInvalid: false, orgDeleted: false };
}

/** A person row tagged with their organisation (combined views name it on every row). */
export type WithOrg<T> = T & { companyId: string | null; companyName: string | null };

export function withOrg<T extends object>(row: T, org: OrgRef | null): WithOrg<T> {
  return { ...row, companyId: org?.id ?? null, companyName: org?.name ?? null };
}

/** Adds up numeric fields of several totals objects (non-numbers: the first one's). */
export function sumTotals<T extends object>(parts: T[], empty: T): T {
  if (!parts.length) return empty;
  const out: Record<string, unknown> = { ...(parts[0] as Record<string, unknown>) };
  for (const part of parts.slice(1)) {
    for (const [k, v] of Object.entries(part as Record<string, unknown>)) {
      const cur = out[k];
      if (typeof v === 'number' && typeof cur === 'number') out[k] = cur + v;
      else if (typeof v === 'boolean' && typeof cur === 'boolean') out[k] = cur || v;
    }
  }
  return out as T;
}
