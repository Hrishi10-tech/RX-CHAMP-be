import { AuthenticatedUser, NO_GRANTS } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { ApprovalSubject, BreakApprovalPolicy } from './break-approval.policy';
import { ShiftPerson } from '../domain/shift-people.reader';
import { toPerson } from '../infrastructure/prisma-shift-people.reader';

/**
 * 4.0 approval routing (docs/4.0/SPEC.md 1.3): by role and department, decided
 * against the subject's organisation and department at decision time.
 */

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function person(id: string, role: ShiftPerson['role'], over: Partial<ShiftPerson> = {}): ShiftPerson {
  return {
    id,
    role,
    firstName: id,
    lastName: '',
    email: `${id}@x.test`,
    department: null,
    designation: null,
    companyId: ORG_A,
    departmentId: null,
    managerId: null,
    active: true,
    ...over,
  };
}

function actor(id: string, role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  const companyId = role === Role.SUPER_ADMIN ? null : ORG_A;
  return {
    id,
    email: `${id}@x.test`,
    role,
    permissions: [],
    department: null,
    companyId,
    status: 'ACTIVE',
    orgId: companyId,
    departmentId: null,
    managedDepartmentIds: [],
    grants: role === Role.MANAGER ? NO_GRANTS : undefined,
    ...over,
  } as AuthenticatedUser;
}

describe('BreakApprovalPolicy.route', () => {
  it('Staff in a department: PENDING for the department managers (approverRole MANAGER, no approverId)', () => {
    expect(BreakApprovalPolicy.route(person('staff', 'USER', { departmentId: 'dept-1' }))).toEqual({
      status: 'PENDING',
      approverRole: 'MANAGER',
      approverId: null,
    });
  });

  it('Staff without a department: PENDING for the organisation Admin', () => {
    expect(BreakApprovalPolicy.route(person('staff', 'USER'))).toEqual({
      status: 'PENDING',
      approverRole: 'ADMIN',
      approverId: null,
    });
  });

  it('Managers (with or without a department): PENDING for the organisation Admin', () => {
    for (const departmentId of [null, 'dept-1']) {
      expect(BreakApprovalPolicy.route(person('mgr', 'MANAGER', { departmentId }))).toEqual({
        status: 'PENDING',
        approverRole: 'ADMIN',
        approverId: null,
      });
    }
  });

  it('Admins and Super Admins: NOT_REQUIRED', () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      expect(BreakApprovalPolicy.route(person('boss', role, { departmentId: 'dept-1' }))).toEqual({
        status: 'NOT_REQUIRED',
        approverRole: null,
        approverId: null,
      });
    }
  });

  it('ignores the 3.x manager argument: never routes by reporting line, never writes approverId', () => {
    const subject = person('staff', 'USER', { departmentId: 'dept-1', managerId: 'mgr' });
    expect(BreakApprovalPolicy.route(subject, person('mgr', 'MANAGER'))).toEqual({
      status: 'PENDING',
      approverRole: 'MANAGER',
      approverId: null,
    });
    expect(BreakApprovalPolicy.route(person('staff', 'USER'), person('sa', 'SUPER_ADMIN')).approverId).toBeNull();
  });
});

describe('BreakApprovalPolicy.canDecide and canView (full matrix)', () => {
  const SUBJECTS = {
    staffDept1: person('staff-d1', 'USER', { departmentId: 'dept-1' }),
    staffDept2: person('staff-d2', 'USER', { departmentId: 'dept-2' }),
    staffDept3: person('staff-d3', 'USER', { departmentId: 'dept-3' }),
    staffNoDept: person('staff-nodept', 'USER'),
    manager: person('mgr-other', 'MANAGER', { departmentId: 'dept-1' }),
    admin: person('admin-other', 'ADMIN'),
    staffOrgB: person('staff-b', 'USER', { companyId: ORG_B, departmentId: 'dept-1' }),
    managerOrgB: person('mgr-b', 'MANAGER', { companyId: ORG_B }),
    superAdmin: person('sa-other', 'SUPER_ADMIN', { companyId: null }),
  };
  type Name = keyof typeof SUBJECTS;
  const NAMES = Object.keys(SUBJECTS) as Name[];

  const ACTORS: { name: string; me: AuthenticatedUser; decides: Name[]; views: Name[] }[] = [
    {
      name: 'Super Admin in org A',
      me: actor('sa', Role.SUPER_ADMIN, { orgId: ORG_A }),
      decides: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'manager'],
      views: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'manager', 'admin'],
    },
    { name: 'Super Admin without an organisation', me: actor('sa', Role.SUPER_ADMIN), decides: [], views: [] },
    {
      name: 'Admin of org A',
      me: actor('admin', Role.ADMIN),
      decides: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'manager'],
      views: ['staffDept1', 'staffDept2', 'staffDept3', 'staffNoDept', 'manager', 'admin'],
    },
    {
      name: 'Manager of dept-1 and dept-2',
      me: actor('mgr', Role.MANAGER, { departmentId: 'dept-1', managedDepartmentIds: ['dept-1', 'dept-2'] }),
      decides: ['staffDept1', 'staffDept2'],
      views: ['staffDept1', 'staffDept2'],
    },
    {
      name: 'Manager with no departments',
      me: actor('mgr', Role.MANAGER, { managedDepartmentIds: [] }),
      decides: [],
      views: [],
    },
    { name: 'Staff', me: actor('staff', Role.USER, { departmentId: 'dept-1' }), decides: [], views: [] },
  ];

  for (const { name, me, decides, views } of ACTORS) {
    it(`${name}: decides ${decides.length ? decides.join(', ') : 'nothing'}`, () => {
      for (const s of NAMES) {
        const subject = SUBJECTS[s];
        expect([s, BreakApprovalPolicy.canDecide(me, { userId: subject.id }, subject)]).toEqual([s, decides.includes(s)]);
        expect([s, BreakApprovalPolicy.canView(me, { userId: subject.id }, subject)]).toEqual([s, views.includes(s)]);
      }
    });

    it(`${name}: never decides their own item, but always sees it`, () => {
      const self: ApprovalSubject = { id: me.id, role: me.role, companyId: me.companyId, departmentId: me.departmentId ?? null };
      expect(BreakApprovalPolicy.canDecide(me, { userId: me.id }, self)).toBe(false);
      expect(BreakApprovalPolicy.canView(me, { userId: me.id }, self)).toBe(true);
    });

    it(`${name}: an unknown (deleted) subject is neither decided nor shown`, () => {
      expect(BreakApprovalPolicy.canDecide(me, { userId: 'gone' }, null)).toBe(false);
      expect(BreakApprovalPolicy.canDecide(me, { userId: 'gone' }, undefined)).toBe(false);
      expect(BreakApprovalPolicy.canView(me, { userId: 'gone' }, null)).toBe(false);
    });
  }

  it('a Super Admin who switches to org B decides org B, not org A', () => {
    const saInB = actor('sa', Role.SUPER_ADMIN, { orgId: ORG_B });
    expect(BreakApprovalPolicy.canDecide(saInB, { userId: 'staff-b' }, SUBJECTS.staffOrgB)).toBe(true);
    expect(BreakApprovalPolicy.canDecide(saInB, { userId: 'mgr-b' }, SUBJECTS.managerOrgB)).toBe(true);
    expect(BreakApprovalPolicy.canDecide(saInB, { userId: 'staff-d1' }, SUBJECTS.staffDept1)).toBe(false);
  });

  it('follows the department at decision time: moving the manager or the staff member re-routes', () => {
    const mgr = actor('mgr', Role.MANAGER, { managedDepartmentIds: ['dept-1'] });
    const staff = SUBJECTS.staffDept1;
    expect(BreakApprovalPolicy.canDecide(mgr, { userId: staff.id }, staff)).toBe(true);
    // The manager is taken off dept-1.
    expect(BreakApprovalPolicy.canDecide({ ...mgr, managedDepartmentIds: ['dept-2'] }, { userId: staff.id }, staff)).toBe(false);
    // The staff member moves to dept-2, or loses their department.
    expect(BreakApprovalPolicy.canDecide(mgr, { userId: staff.id }, { ...staff, departmentId: 'dept-2' })).toBe(false);
    expect(BreakApprovalPolicy.canDecide(mgr, { userId: staff.id }, { ...staff, departmentId: null })).toBe(false);
  });

  it('a Manager decides without any view grant (grants only gate screenshots, timeline and activity)', () => {
    const mgr = actor('mgr', Role.MANAGER, { managedDepartmentIds: ['dept-1'], grants: NO_GRANTS });
    expect(BreakApprovalPolicy.canDecide(mgr, { userId: 'staff-d1' }, SUBJECTS.staffDept1)).toBe(true);
  });

  it('orgOf is the organisation the approver acts in', () => {
    expect(BreakApprovalPolicy.orgOf(actor('admin', Role.ADMIN))).toBe(ORG_A);
    expect(BreakApprovalPolicy.orgOf(actor('sa', Role.SUPER_ADMIN))).toBeNull();
    expect(BreakApprovalPolicy.orgOf(actor('sa', Role.SUPER_ADMIN, { orgId: ORG_B }))).toBe(ORG_B);
  });
});

describe('toPerson', () => {
  it('a soft-deleted or disabled person is never active, whatever their status says', () => {
    const row = {
      id: 'mgr',
      firstName: 'Maya',
      lastName: 'Reddy',
      email: 'maya@x.test',
      department: 'Engineering',
      designation: null,
      companyId: ORG_A,
      departmentId: 'dept-1',
      managerId: null,
      status: 'ACTIVE' as const,
      deletedAt: new Date('2026-10-01T00:00:00Z'),
      role: { name: 'MANAGER' as const },
    };
    expect(toPerson(row).active).toBe(false);
    expect(toPerson({ ...row, deletedAt: null }).active).toBe(true);
    expect(toPerson({ ...row, deletedAt: null, status: 'DISABLED' }).active).toBe(false);
    expect(toPerson({ ...row, deletedAt: null })).toMatchObject({ companyId: ORG_A, departmentId: 'dept-1', role: 'MANAGER' });
  });
});
