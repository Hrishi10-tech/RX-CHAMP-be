import { ForbiddenError, NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser, NO_GRANTS, ViewGrants } from '@shared/rbac/authenticated-user';
import { Role, seesEveryOrg } from '@shared/rbac/roles.enum';

/**
 * 4.0 tenancy and scope rules (docs/4.0/SPEC.md 1.2 to 1.4), as pure functions so
 * every module applies the same matrix and tests can cover it without a database.
 *
 *  - Everything people-owned is filtered by organisation (orgOf).
 *  - Admin and Super Admin (with an organisation selected) see and change everyone
 *    in it except Super Admins; the Super Admin may also change the Admin.
 *  - A Manager sees Staff in their departments, read-only, and only the sections
 *    their grants allow. A Manager with no departments sees nobody.
 *  - Staff see themselves.
 *  - The Super Manager (3.3) acts in the organisation picked with X-Org-Id, like the
 *    Super Admin, sees everyone in it but Super Admins, with every section, and
 *    changes Staff only. Lists that combine organisations use peopleWhereAnyOrg.
 *  - A target outside the caller's scope is reported as not found (never 403), so
 *    existence does not leak across organisations.
 */

export type Section = 'screenshots' | 'timeline' | 'activity';

/** The facts about a person that scope decisions need. */
export interface PersonFacts {
  id: string;
  role: Role | string;
  companyId: string | null;
  departmentId: string | null;
}

/** The organisation this request acts in, or null (a Super Admin on the platform view). */
export function orgOf(me: AuthenticatedUser): string | null {
  if (me.orgDeleted) return null;
  if (seesEveryOrg(me.role)) return me.orgId ?? null;
  return me.orgId ?? me.companyId ?? null;
}

/**
 * orgOf, or the right refusal: 404 ORG_NOT_FOUND for an organisation that does not
 * exist or was deleted (X-Org-Id, or the person's own), 400 ORG_REQUIRED for a
 * Super Admin with none picked, 403 NO_ORGANISATION otherwise.
 */
export function requireOrg(me: AuthenticatedUser): string {
  if (me.orgHeaderInvalid || me.orgDeleted)
    throw new NotFoundError('That organisation does not exist.', 'ORG_NOT_FOUND');
  const org = orgOf(me);
  if (org) return org;
  if (seesEveryOrg(me.role)) {
    throw new ValidationError('Choose an organisation first.', 'ORG_REQUIRED');
  }
  throw new ForbiddenError(
    'Your account is not part of an organisation yet. Ask your administrator.',
    'NO_ORGANISATION',
  );
}

export function isAdminLike(me: AuthenticatedUser): boolean {
  return me.role === Role.ADMIN || me.role === Role.SUPER_ADMIN;
}

/** The 3.3 Super Manager: every organisation, read and decide, Staff edits only. */
export function isSuperManager(me: AuthenticatedUser): boolean {
  return me.role === Role.SUPER_MANAGER;
}

/** Admin, Super Admin or Super Manager: sees everyone in the organisation it acts in. */
export function seesWholeOrg(me: AuthenticatedUser): boolean {
  return isAdminLike(me) || isSuperManager(me);
}

export function isManager(me: AuthenticatedUser): boolean {
  return me.role === Role.MANAGER;
}

export function grantsOf(me: AuthenticatedUser): ViewGrants {
  if (seesWholeOrg(me)) return { screenshots: true, timeline: true, activity: true };
  if (me.role === Role.MANAGER) return me.grants ?? NO_GRANTS;
  return NO_GRANTS;
}

export function hasAnyGrant(me: AuthenticatedUser): boolean {
  const g = grantsOf(me);
  return g.screenshots || g.timeline || g.activity;
}

/**
 * 403 GRANT_REQUIRED for a Manager with no view grant at all: Team and every view
 * of a person's live status or day (docs/4.0/SPEC.md 1.2) need at least one.
 * Admins and Super Admins always pass.
 */
export function assertAnyGrant(me: AuthenticatedUser): void {
  if (!hasAnyGrant(me)) {
    throw new ForbiddenError('Ask your admin for access to your team.', 'GRANT_REQUIRED');
  }
}

export function managedDeptIds(me: AuthenticatedUser): string[] {
  return me.role === Role.MANAGER ? (me.managedDepartmentIds ?? []) : [];
}

/** Whether `t` belongs to the organisation the caller acts in. */
export function inMyOrg(me: AuthenticatedUser, t: PersonFacts): boolean {
  const org = orgOf(me);
  return !!org && t.companyId === org;
}

/**
 * Whether the caller may read `t` at all (name, day, reports, approvals).
 * Self is always visible.
 */
export function canSeePerson(me: AuthenticatedUser, t: PersonFacts): boolean {
  if (t.id === me.id) return true;
  if (t.role === Role.SUPER_ADMIN) return false;
  if (!inMyOrg(me, t)) return false;
  if (seesWholeOrg(me)) return true;
  if (me.role === Role.MANAGER) {
    return t.role === Role.USER && !!t.departmentId && managedDeptIds(me).includes(t.departmentId);
  }
  return false;
}

/**
 * Whether the caller may change `t` (edit, block, delete, credentials, capture
 * settings, grants). Never self through these paths; self-service is separate.
 * A Super Manager account is changed by a Super Admin only, organisation or not.
 */
export function canEditPerson(me: AuthenticatedUser, t: PersonFacts): boolean {
  if (t.id === me.id) return false;
  if (t.role === Role.SUPER_ADMIN) return false;
  // Super Manager accounts belong to no organisation: a Super Admin manages them
  // from anywhere (organisation selected or not); nobody else touches them.
  if (t.role === Role.SUPER_MANAGER) return me.role === Role.SUPER_ADMIN;
  if (!inMyOrg(me, t)) return false;
  if (me.role === Role.SUPER_ADMIN) return true;
  if (me.role === Role.ADMIN) return t.role === Role.MANAGER || t.role === Role.USER;
  if (me.role === Role.SUPER_MANAGER) return t.role === Role.USER;
  return false;
}

/** Whether the caller may see one detail section (screenshots, timeline, activity) of `t`. */
export function canViewSection(me: AuthenticatedUser, t: PersonFacts, section: Section): boolean {
  if (t.id === me.id) return true;
  if (!canSeePerson(me, t)) return false;
  return grantsOf(me)[section];
}

/** Throws 404 when `t` is missing or outside what the caller may see. */
export function assertCanSee<T extends PersonFacts>(
  me: AuthenticatedUser,
  t: T | null | undefined,
  what = 'person',
): T {
  if (!t || !canSeePerson(me, t)) throw new NotFoundError(`Unknown ${what}`);
  return t;
}

/** Throws 404 outside the org/scope, 403 when visible but not editable. */
export function assertCanEdit<T extends PersonFacts>(
  me: AuthenticatedUser,
  t: T | null | undefined,
  what = 'person',
): T {
  if (!t || (!canSeePerson(me, t) && !canEditPerson(me, t)))
    throw new NotFoundError(`Unknown ${what}`);
  if (!canEditPerson(me, t)) {
    throw new ForbiddenError(
      t.id === me.id
        ? 'You cannot change your own account here.'
        : me.role === Role.SUPER_MANAGER
          ? 'The Super Manager changes Staff only; Managers and admins are read-only.'
          : 'Only the organisation admin can change people.',
    );
  }
  return t;
}

/** Throws 404 outside scope and 403 when the section is not granted. */
export function assertCanViewSection<T extends PersonFacts>(
  me: AuthenticatedUser,
  t: T | null | undefined,
  section: Section,
): T {
  if (!t || !canSeePerson(me, t)) throw new NotFoundError('Unknown person');
  if (!canViewSection(me, t, section)) {
    throw new ForbiddenError(
      `You do not have access to ${section === 'timeline' ? 'the timeline' : section}.`,
      'GRANT_REQUIRED',
    );
  }
  return t;
}

/**
 * Prisma `where` on users for everyone the caller may see in lists (Team, reports,
 * approvals, messages), deleted people excluded unless asked. Super Admins are never
 * members of an organisation's lists. Requires an organisation.
 */
export function peopleWhere(
  me: AuthenticatedUser,
  opts: { includeDeleted?: boolean; includeSelf?: boolean } = {},
): Record<string, unknown> {
  const org = requireOrg(me);
  const base: Record<string, unknown> = {
    companyId: org,
    role: { name: { not: Role.SUPER_ADMIN } },
  };
  if (!opts.includeDeleted) base.deletedAt = null;
  if (seesWholeOrg(me)) return base;
  const visible: Record<string, unknown>[] = [];
  if (me.role === Role.MANAGER) {
    const depts = managedDeptIds(me);
    if (depts.length) visible.push({ role: { name: Role.USER }, departmentId: { in: depts } });
  }
  if (opts.includeSelf) visible.push({ id: me.id });
  if (!visible.length) return { ...base, id: { in: [] } };
  return { AND: [base, { OR: visible }] };
}

/** Department ids the caller may see (null = every department of the organisation). */
export function visibleDeptIds(me: AuthenticatedUser): string[] | null {
  if (seesWholeOrg(me)) return null;
  return managedDeptIds(me);
}

/**
 * 3.3 combined views. The organisation a Super Manager or Super Admin has in view:
 * the one picked (X-Org-Id), or null for "All organisations". Everyone else: their
 * own organisation, with requireOrg's refusals.
 */
export function orgInView(me: AuthenticatedUser): string | null {
  if (me.orgHeaderInvalid)
    throw new NotFoundError('That organisation does not exist.', 'ORG_NOT_FOUND');
  if (seesEveryOrg(me.role)) return me.orgId ?? null;
  return requireOrg(me);
}

/**
 * peopleWhere, except that a Super Manager or Super Admin with "All organisations"
 * in view gets everyone in every live organisation (Super Admins excluded).
 */
export function peopleWhereAnyOrg(
  me: AuthenticatedUser,
  opts: { includeDeleted?: boolean; includeSelf?: boolean } = {},
): Record<string, unknown> {
  if (!seesEveryOrg(me.role) || orgInView(me)) return peopleWhere(me, opts);
  const base: Record<string, unknown> = {
    companyId: { not: null },
    company: { deletedAt: null },
    role: { name: { not: Role.SUPER_ADMIN } },
  };
  if (!opts.includeDeleted) base.deletedAt = null;
  return base;
}
