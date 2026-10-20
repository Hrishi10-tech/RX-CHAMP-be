import { AppException } from '@shared/exceptions/app.exception';
import { AuthenticatedUser, NO_GRANTS, ViewGrants } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import {
  assertCanEdit,
  assertCanSee,
  assertCanViewSection,
  canEditPerson,
  canSeePerson,
  canViewSection,
  grantsOf,
  hasAnyGrant,
  inMyOrg,
  isAdminLike,
  isManager,
  managedDeptIds,
  orgOf,
  peopleWhere,
  PersonFacts,
  requireOrg,
  Section,
  visibleDeptIds,
} from './scope';

/**
 * The 4.0 scope matrix (docs/4.0/SPEC.md 1.2 to 1.4) over every role and every
 * kind of target: same organisation, other organisation, self, Super Admin.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function actor(role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  const companyId = role === Role.SUPER_ADMIN ? null : ORG_A;
  return {
    id: `${role.toLowerCase()}-me`,
    email: `${role.toLowerCase()}@a.test`,
    role,
    permissions: [],
    department: null,
    companyId,
    status: 'ACTIVE',
    orgId: companyId,
    departmentId: null,
    managedDepartmentIds: [],
    ...over,
  } as AuthenticatedUser;
}

const grants = (g: Partial<ViewGrants> = {}): ViewGrants => ({ ...NO_GRANTS, ...g });

// ---- actors
const SA_IN_A = actor(Role.SUPER_ADMIN, { orgId: ORG_A });
const SA_PLATFORM = actor(Role.SUPER_ADMIN);
const SA_BAD_HEADER = actor(Role.SUPER_ADMIN, { orgHeaderInvalid: true });
const ADMIN_A = actor(Role.ADMIN);
const MGR_A = actor(Role.MANAGER, {
  departmentId: 'dept-1',
  managedDepartmentIds: ['dept-1', 'dept-2'],
  grants: grants({ screenshots: true, timeline: true, activity: true }),
});
const MGR_NO_DEPTS = actor(Role.MANAGER, {
  id: 'mgr-nodept',
  managedDepartmentIds: [],
  grants: grants({ screenshots: true }),
});
const MGR_NO_GRANTS = actor(Role.MANAGER, {
  id: 'mgr-nogrant',
  managedDepartmentIds: ['dept-1'],
  grants: undefined,
});
const STAFF_A = actor(Role.USER, { id: 'staff-me', departmentId: 'dept-1' });
const STAFF_NO_ORG = actor(Role.USER, { id: 'staff-noorg', companyId: null, orgId: null });

// ---- targets
const person = (
  id: string,
  role: Role,
  companyId: string | null,
  departmentId: string | null,
): PersonFacts => ({
  id,
  role,
  companyId,
  departmentId,
});
const T = {
  staffDept1: person('t-staff-d1', Role.USER, ORG_A, 'dept-1'),
  staffDept2: person('t-staff-d2', Role.USER, ORG_A, 'dept-2'),
  staffDept3: person('t-staff-d3', Role.USER, ORG_A, 'dept-3'),
  staffNoDept: person('t-staff-nodept', Role.USER, ORG_A, null),
  managerA: person('t-mgr', Role.MANAGER, ORG_A, 'dept-1'),
  adminA: person('t-admin', Role.ADMIN, ORG_A, null),
  staffOrgB: person('t-staff-b', Role.USER, ORG_B, 'dept-1'), // even a matching department id never crosses orgs
  managerOrgB: person('t-mgr-b', Role.MANAGER, ORG_B, null),
  adminOrgB: person('t-admin-b', Role.ADMIN, ORG_B, null),
  superAdmin: person('t-sa', Role.SUPER_ADMIN, null, null),
  superAdminWithCompany: person('t-sa2', Role.SUPER_ADMIN, ORG_A, null),
};
type TargetName = keyof typeof T;
const TARGETS = Object.keys(T) as TargetName[];
const selfOf = (me: AuthenticatedUser): PersonFacts => ({
  id: me.id,
  role: me.role,
  companyId: me.companyId,
  departmentId: me.departmentId ?? null,
});

/** Runs fn and returns the AppException it throws (status and code), or null. */
function refusal(fn: () => unknown): { status: number; code: string } | null {
  try {
    fn();
    return null;
  } catch (e) {
    if (!(e instanceof AppException)) throw e;
    return { status: e.status, code: e.code };
  }
}

describe('orgOf / requireOrg', () => {
  it('a Super Admin acts in the organisation chosen with X-Org-Id, or none', () => {
    expect(orgOf(SA_IN_A)).toBe(ORG_A);
    expect(orgOf(SA_PLATFORM)).toBeNull();
    // A Super Admin's own companyId (3.x data) is ignored.
    expect(orgOf(actor(Role.SUPER_ADMIN, { companyId: ORG_B, orgId: null }))).toBeNull();
  });

  it('everyone else acts in their own organisation', () => {
    expect(orgOf(ADMIN_A)).toBe(ORG_A);
    expect(orgOf(MGR_A)).toBe(ORG_A);
    expect(orgOf(STAFF_A)).toBe(ORG_A);
    // Falls back to companyId when the request context did not fill orgId.
    expect(orgOf(actor(Role.MANAGER, { orgId: undefined }))).toBe(ORG_A);
    expect(orgOf(STAFF_NO_ORG)).toBeNull();
  });

  it('requireOrg returns the organisation or refuses with the right status and code', () => {
    expect(requireOrg(SA_IN_A)).toBe(ORG_A);
    expect(requireOrg(ADMIN_A)).toBe(ORG_A);
    expect(requireOrg(STAFF_A)).toBe(ORG_A);
    expect(refusal(() => requireOrg(SA_PLATFORM))).toEqual({ status: 400, code: 'ORG_REQUIRED' });
    expect(refusal(() => requireOrg(SA_BAD_HEADER))).toEqual({
      status: 404,
      code: 'ORG_NOT_FOUND',
    });
    expect(refusal(() => requireOrg(STAFF_NO_ORG))).toEqual({
      status: 403,
      code: 'NO_ORGANISATION',
    });
    expect(refusal(() => requireOrg(actor(Role.ADMIN, { companyId: null, orgId: null })))).toEqual({
      status: 403,
      code: 'NO_ORGANISATION',
    });
  });

  it('an invalid X-Org-Id answers 404 even when an organisation is otherwise known', () => {
    expect(refusal(() => requireOrg({ ...SA_IN_A, orgHeaderInvalid: true }))).toEqual({
      status: 404,
      code: 'ORG_NOT_FOUND',
    });
  });

  it('someone whose organisation was deleted acts in none: 404 ORG_NOT_FOUND (audit L4)', () => {
    for (const role of [Role.ADMIN, Role.MANAGER, Role.USER]) {
      const gone = actor(role, { orgDeleted: true });
      expect(orgOf(gone)).toBeNull();
      expect(refusal(() => requireOrg(gone))).toEqual({ status: 404, code: 'ORG_NOT_FOUND' });
      expect(refusal(() => peopleWhere(gone))).toEqual({ status: 404, code: 'ORG_NOT_FOUND' });
    }
  });
});

describe('roles and grants', () => {
  it('knows admin-like roles and managers', () => {
    expect(isAdminLike(SA_IN_A)).toBe(true);
    expect(isAdminLike(SA_PLATFORM)).toBe(true);
    expect(isAdminLike(ADMIN_A)).toBe(true);
    expect(isAdminLike(MGR_A)).toBe(false);
    expect(isAdminLike(STAFF_A)).toBe(false);
    expect(isManager(MGR_A)).toBe(true);
    expect(isManager(ADMIN_A)).toBe(false);
  });

  it('Admin and Super Admin (with or without an organisation) hold every grant', () => {
    const all = { screenshots: true, timeline: true, activity: true };
    expect(grantsOf(SA_IN_A)).toEqual(all);
    expect(grantsOf(SA_PLATFORM)).toEqual(all);
    expect(grantsOf(ADMIN_A)).toEqual(all);
    expect(hasAnyGrant(ADMIN_A)).toBe(true);
  });

  it.each<[keyof ViewGrants]>([['screenshots'], ['timeline'], ['activity']])(
    'a Manager holds exactly the %s grant they were given',
    (g) => {
      const m = actor(Role.MANAGER, {
        managedDepartmentIds: ['dept-1'],
        grants: grants({ [g]: true }),
      });
      expect(grantsOf(m)).toEqual(grants({ [g]: true }));
      expect(hasAnyGrant(m)).toBe(true);
    },
  );

  it('a Manager without grants holds none; Staff never hold grants', () => {
    expect(grantsOf(MGR_NO_GRANTS)).toEqual(NO_GRANTS);
    expect(hasAnyGrant(MGR_NO_GRANTS)).toBe(false);
    expect(hasAnyGrant(actor(Role.MANAGER, { grants: grants() }))).toBe(false);
    const staffWithStrayGrants = actor(Role.USER, {
      grants: grants({ screenshots: true, timeline: true, activity: true }),
    });
    expect(grantsOf(staffWithStrayGrants)).toEqual(NO_GRANTS);
    expect(hasAnyGrant(staffWithStrayGrants)).toBe(false);
  });

  it('only a Manager has managed departments; the visible department list follows', () => {
    expect(managedDeptIds(MGR_A)).toEqual(['dept-1', 'dept-2']);
    expect(managedDeptIds(MGR_NO_DEPTS)).toEqual([]);
    expect(managedDeptIds(actor(Role.MANAGER, { managedDepartmentIds: undefined }))).toEqual([]);
    expect(managedDeptIds(actor(Role.ADMIN, { managedDepartmentIds: ['dept-1'] }))).toEqual([]);
    expect(managedDeptIds(actor(Role.USER, { managedDepartmentIds: ['dept-1'] }))).toEqual([]);
    expect(visibleDeptIds(ADMIN_A)).toBeNull();
    expect(visibleDeptIds(SA_IN_A)).toBeNull();
    expect(visibleDeptIds(MGR_A)).toEqual(['dept-1', 'dept-2']);
    expect(visibleDeptIds(MGR_NO_DEPTS)).toEqual([]);
    expect(visibleDeptIds(STAFF_A)).toEqual([]);
  });
});

/** Expected visibility: actor name -> the targets it may see (self is always visible). */
const SEE: Record<string, { me: AuthenticatedUser; sees: TargetName[] }> = {
  'Super Admin in org A': {
    me: SA_IN_A,
    sees: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'managerA', 'adminA'],
  },
  'Super Admin without an organisation': { me: SA_PLATFORM, sees: [] },
  'Admin of org A': {
    me: ADMIN_A,
    sees: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'managerA', 'adminA'],
  },
  'Manager of dept-1 and dept-2': { me: MGR_A, sees: ['staffDept1', 'staffDept2'] },
  'Manager with no departments': { me: MGR_NO_DEPTS, sees: [] },
  'Manager without grants': { me: MGR_NO_GRANTS, sees: ['staffDept1'] },
  Staff: { me: STAFF_A, sees: [] },
  'Staff outside any organisation': { me: STAFF_NO_ORG, sees: [] },
};

describe('canSeePerson', () => {
  for (const [name, { me, sees }] of Object.entries(SEE)) {
    it(`${name}: sees exactly ${sees.length ? sees.join(', ') : 'nobody'} (and self)`, () => {
      for (const t of TARGETS) {
        expect([t, canSeePerson(me, T[t])]).toEqual([t, sees.includes(t)]);
      }
      expect(canSeePerson(me, selfOf(me))).toBe(true);
    });
  }

  it('never sees another Super Admin, even one with a company in the organisation', () => {
    for (const { me } of Object.values(SEE)) {
      expect(canSeePerson(me, T.superAdmin)).toBe(false);
      expect(canSeePerson(me, T.superAdminWithCompany)).toBe(false);
    }
  });

  it('never sees across organisations', () => {
    for (const { me } of Object.values(SEE)) {
      for (const t of ['staffOrgB', 'managerOrgB', 'adminOrgB'] as const)
        expect(canSeePerson(me, T[t])).toBe(false);
    }
    // A Super Admin who switches to org B sees B, not A.
    const saInB = actor(Role.SUPER_ADMIN, { orgId: ORG_B });
    expect(canSeePerson(saInB, T.staffOrgB)).toBe(true);
    expect(canSeePerson(saInB, T.adminOrgB)).toBe(true);
    expect(canSeePerson(saInB, T.staffDept1)).toBe(false);
  });

  it('inMyOrg is false without an organisation', () => {
    expect(inMyOrg(SA_PLATFORM, T.staffDept1)).toBe(false);
    expect(inMyOrg(ADMIN_A, T.staffDept1)).toBe(true);
    expect(inMyOrg(ADMIN_A, T.staffOrgB)).toBe(false);
  });
});

/** Expected edit rights: actor -> targets it may change (never self). */
const EDIT: Record<string, { me: AuthenticatedUser; edits: TargetName[] }> = {
  'Super Admin in org A': {
    me: SA_IN_A,
    edits: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'managerA', 'adminA'],
  },
  'Super Admin without an organisation': { me: SA_PLATFORM, edits: [] },
  'Admin of org A': {
    me: ADMIN_A,
    edits: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'managerA'],
  },
  'Manager of dept-1 and dept-2': { me: MGR_A, edits: [] },
  'Manager with no departments': { me: MGR_NO_DEPTS, edits: [] },
  Staff: { me: STAFF_A, edits: [] },
};

describe('canEditPerson', () => {
  for (const [name, { me, edits }] of Object.entries(EDIT)) {
    it(`${name}: changes exactly ${edits.length ? edits.join(', ') : 'nobody'}, never self`, () => {
      for (const t of TARGETS) {
        expect([t, canEditPerson(me, T[t])]).toEqual([t, edits.includes(t)]);
      }
      expect(canEditPerson(me, selfOf(me))).toBe(false);
    });
  }

  it('an Admin cannot change another Admin of the same organisation; the Super Admin can', () => {
    const otherAdmin = person('t-admin-2', Role.ADMIN, ORG_A, null);
    expect(canEditPerson(ADMIN_A, otherAdmin)).toBe(false);
    expect(canEditPerson(SA_IN_A, otherAdmin)).toBe(true);
  });
});

describe('canViewSection', () => {
  const SECTIONS: Section[] = ['screenshots', 'timeline', 'activity'];

  it('Admin and Super Admin see every section of anyone they can see', () => {
    for (const me of [ADMIN_A, SA_IN_A]) {
      for (const s of SECTIONS) {
        expect(canViewSection(me, T.staffDept1, s)).toBe(true);
        expect(canViewSection(me, T.managerA, s)).toBe(true);
        expect(canViewSection(me, T.staffOrgB, s)).toBe(false);
        expect(canViewSection(me, T.superAdmin, s)).toBe(false);
      }
    }
    for (const s of SECTIONS) expect(canViewSection(SA_PLATFORM, T.staffDept1, s)).toBe(false);
  });

  it.each<[Section]>([['screenshots'], ['timeline'], ['activity']])(
    'a Manager with only the %s grant sees only that section, only for staff in their departments',
    (granted) => {
      const m = actor(Role.MANAGER, {
        managedDepartmentIds: ['dept-1'],
        grants: grants({ [granted]: true }),
      });
      for (const s of SECTIONS) {
        expect([s, canViewSection(m, T.staffDept1, s)]).toEqual([s, s === granted]);
        expect(canViewSection(m, T.staffDept3, s)).toBe(false);
        expect(canViewSection(m, T.managerA, s)).toBe(false);
        expect(canViewSection(m, T.staffOrgB, s)).toBe(false);
      }
    },
  );

  it('a Manager with no grants or no departments sees no section of anyone else', () => {
    for (const s of SECTIONS) {
      expect(canViewSection(MGR_NO_GRANTS, T.staffDept1, s)).toBe(false);
      expect(canViewSection(MGR_NO_DEPTS, T.staffDept1, s)).toBe(false);
    }
  });

  it('everyone sees every section of themselves; Staff nothing of anyone else', () => {
    for (const me of [STAFF_A, MGR_NO_GRANTS, MGR_NO_DEPTS, SA_PLATFORM]) {
      for (const s of SECTIONS) expect(canViewSection(me, selfOf(me), s)).toBe(true);
    }
    for (const s of SECTIONS) {
      expect(canViewSection(STAFF_A, T.staffDept1, s)).toBe(false);
    }
  });
});

describe('assertions answer 404 outside scope and 403 inside it', () => {
  it('assertCanSee: the target when visible, 404 when missing or out of scope', () => {
    expect(assertCanSee(MGR_A, T.staffDept1)).toBe(T.staffDept1);
    expect(refusal(() => assertCanSee(MGR_A, null))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(refusal(() => assertCanSee(MGR_A, T.staffDept3))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(refusal(() => assertCanSee(ADMIN_A, T.staffOrgB))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('assertCanEdit: 404 across organisations, 403 when visible but not editable', () => {
    expect(assertCanEdit(ADMIN_A, T.managerA)).toBe(T.managerA);
    expect(refusal(() => assertCanEdit(ADMIN_A, T.staffOrgB))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(refusal(() => assertCanEdit(ADMIN_A, undefined))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    // A Manager sees their staff but never edits them.
    expect(refusal(() => assertCanEdit(MGR_A, T.staffDept1))).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
    // ... and does not even learn that staff of other departments exist.
    expect(refusal(() => assertCanEdit(MGR_A, T.staffDept3))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    // Self: visible, not editable here.
    expect(refusal(() => assertCanEdit(ADMIN_A, selfOf(ADMIN_A)))).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
    // A Super Admin in the organisation edits its Admin.
    expect(assertCanEdit(SA_IN_A, T.adminA)).toBe(T.adminA);
  });

  it('assertCanViewSection: 404 outside scope, 403 GRANT_REQUIRED without the grant', () => {
    const m = actor(Role.MANAGER, {
      managedDepartmentIds: ['dept-1'],
      grants: grants({ timeline: true }),
    });
    expect(assertCanViewSection(m, T.staffDept1, 'timeline')).toBe(T.staffDept1);
    expect(refusal(() => assertCanViewSection(m, T.staffDept1, 'screenshots'))).toEqual({
      status: 403,
      code: 'GRANT_REQUIRED',
    });
    expect(refusal(() => assertCanViewSection(m, T.staffDept3, 'timeline'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(refusal(() => assertCanViewSection(m, null, 'timeline'))).toEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

/**
 * A tiny evaluator for the `where` shapes peopleWhere builds, so the list filter
 * can be checked against canSeePerson on the same people.
 */
type Row = PersonFacts & { deletedAt: Date | null };
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((w) => matches(w, row));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(w, row));
    if (key === 'role') {
      const name = (cond as { name: unknown }).name;
      if (typeof name === 'string') return row.role === name;
      return row.role !== (name as { not: string }).not;
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (cond === null) return value === null;
    if (typeof cond === 'object' && cond && 'in' in cond)
      return (cond as { in: unknown[] }).in.includes(value);
    return value === cond;
  });
}

describe('peopleWhere', () => {
  it('needs an organisation', () => {
    expect(refusal(() => peopleWhere(SA_PLATFORM))).toEqual({ status: 400, code: 'ORG_REQUIRED' });
    expect(refusal(() => peopleWhere(SA_BAD_HEADER))).toEqual({
      status: 404,
      code: 'ORG_NOT_FOUND',
    });
    expect(refusal(() => peopleWhere(STAFF_NO_ORG))).toEqual({
      status: 403,
      code: 'NO_ORGANISATION',
    });
  });

  it('Admin and Super Admin: everyone in the organisation except Super Admins, deleted left out unless asked', () => {
    const base = { companyId: ORG_A, role: { name: { not: Role.SUPER_ADMIN } }, deletedAt: null };
    expect(peopleWhere(ADMIN_A)).toEqual(base);
    expect(peopleWhere(SA_IN_A)).toEqual(base);
    expect(peopleWhere(ADMIN_A, { includeDeleted: true })).toEqual({
      companyId: ORG_A,
      role: { name: { not: Role.SUPER_ADMIN } },
    });
  });

  it('Manager: staff in their departments, plus self when asked', () => {
    const base = { companyId: ORG_A, role: { name: { not: Role.SUPER_ADMIN } }, deletedAt: null };
    expect(peopleWhere(MGR_A)).toEqual({
      AND: [
        base,
        { OR: [{ role: { name: Role.USER }, departmentId: { in: ['dept-1', 'dept-2'] } }] },
      ],
    });
    expect(peopleWhere(MGR_A, { includeSelf: true })).toEqual({
      AND: [
        base,
        {
          OR: [
            { role: { name: Role.USER }, departmentId: { in: ['dept-1', 'dept-2'] } },
            { id: MGR_A.id },
          ],
        },
      ],
    });
  });

  it('a Manager with no departments, and Staff, match nobody (or only themselves)', () => {
    const base = { companyId: ORG_A, role: { name: { not: Role.SUPER_ADMIN } }, deletedAt: null };
    expect(peopleWhere(MGR_NO_DEPTS)).toEqual({ ...base, id: { in: [] } });
    expect(peopleWhere(STAFF_A)).toEqual({ ...base, id: { in: [] } });
    expect(peopleWhere(STAFF_A, { includeSelf: true })).toEqual({
      AND: [base, { OR: [{ id: STAFF_A.id }] }],
    });
  });

  it('matches exactly the people canSeePerson allows, for every actor and target', () => {
    const rows: Row[] = TARGETS.map((t) => ({ ...T[t], deletedAt: null }));
    for (const { me } of Object.values(SEE)) {
      if (!orgOf(me)) continue;
      const where = peopleWhere(me);
      for (const r of rows) {
        expect([me.id, r.id, matches(where, r)]).toEqual([me.id, r.id, canSeePerson(me, r)]);
      }
      // Deleted people only when asked.
      const gone = { ...T.staffDept1, deletedAt: new Date() };
      expect(matches(where, gone)).toBe(false);
      expect(matches(peopleWhere(me, { includeDeleted: true }), gone)).toBe(canSeePerson(me, gone));
    }
  });
});
