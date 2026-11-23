import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { LeavePeopleService } from './leave-people.service';

/**
 * 4.0 tenancy for leave (3.4): an organisation's admins see its people; a Manager
 * the Staff of their departments; nobody another organisation's; the routing reads
 * the department's managers and the organisation's admins.
 */
const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const person = (id: string, role: string, companyId = ORG, departmentId: string | null = 'd1') => ({
  id,
  firstName: id,
  lastName: '',
  email: `${id}@rx.test`,
  role,
  department: departmentId ? `Dept ${departmentId}` : null,
  designation: null,
  companyId,
  departmentId,
  managerId: null,
  active: true,
});
const PEOPLE = [
  person('staff', 'USER'),
  person('other', 'USER', ORG, 'd2'),
  person('mgr', 'MANAGER', ORG, null),
  person('admin', 'ADMIN', ORG, null),
  person('far', 'USER', OTHER, 'dx'),
];

const actor = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}) =>
  ({
    id,
    role,
    companyId: role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER ? null : ORG,
    orgId: ORG,
    departmentId: null,
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
    ...over,
  }) as unknown as AuthenticatedUser;

function setup() {
  const reader = {
    findAnyByIds: jest.fn(async (ids: string[]) => PEOPLE.filter((p) => ids.includes(p.id))),
    findMany: jest.fn(
      async (q: { companyId?: string; departmentIds?: string[]; roles?: string[] }) =>
        PEOPLE.filter(
          (p) =>
            (!q.companyId || p.companyId === q.companyId) &&
            (!q.departmentIds || (p.departmentId && q.departmentIds.includes(p.departmentId))) &&
            (!q.roles || q.roles.includes(p.role)),
        ),
    ),
    listDepartmentManagerIds: jest.fn(async (d: string) => (d === 'd1' ? ['mgr'] : [])),
    listOrgAdminIds: jest.fn(async (c: string) => (c === ORG ? ['admin'] : [])),
    listSuperAdminIds: jest.fn(async () => ['sa']),
  };
  const repo = { activeRoleIds: jest.fn(async () => ['sm']) };
  const svc = new LeavePeopleService(reader as never, repo as never, {} as never, {} as never);
  return { svc, reader };
}

describe('LeavePeopleService on 4.0 tenancy', () => {
  it("an Admin sees their organisation's people, never another's (404)", async () => {
    const { svc } = setup();
    const me = actor('admin', Role.ADMIN);
    await expect(svc.visible(me, 'staff')).resolves.toMatchObject({ id: 'staff' });
    await expect(svc.visible(me, 'mgr')).resolves.toMatchObject({ id: 'mgr' });
    await expect(svc.visible(me, 'far')).rejects.toMatchObject({ status: 404 });
    const ids = (await svc.scopePeople(me)).map((p) => p.id).sort();
    expect(ids).toEqual(['admin', 'mgr', 'other', 'staff']);
  });

  it('a Manager sees the Staff of their departments only', async () => {
    const { svc } = setup();
    const me = actor('mgr', Role.MANAGER);
    await expect(svc.visible(me, 'staff')).resolves.toMatchObject({ id: 'staff' });
    await expect(svc.visible(me, 'other')).rejects.toMatchObject({ status: 404 });
    expect((await svc.scopePeople(me)).map((p) => p.id)).toEqual(['staff']);
    expect(await svc.scopeIds(me)).toEqual(['staff']);
  });

  it('Staff see only their own leave', async () => {
    const { svc } = setup();
    const me = actor('staff', Role.USER);
    await expect(svc.visible(me, 'staff')).resolves.toMatchObject({ id: 'staff' });
    await expect(svc.visible(me, 'other')).rejects.toMatchObject({ status: 403 });
    await expect(svc.scopePeople(me)).rejects.toMatchObject({ status: 403 });
  });

  it('a Super Admin on "All organisations" sees everyone; with one in view, that one', async () => {
    const { svc } = setup();
    const all = actor('sa', Role.SUPER_ADMIN, { orgId: null } as never);
    expect(await svc.scopeIds(all)).toBeUndefined();
    await expect(svc.visible(all, 'far')).resolves.toMatchObject({ id: 'far' });
    const inOrg = actor('sa', Role.SUPER_ADMIN);
    await expect(svc.visible(inOrg, 'far')).rejects.toMatchObject({ status: 404 });
  });

  it("routing reads the department's managers and the organisation's admins", async () => {
    const { svc } = setup();
    await expect(svc.routingPeople(PEOPLE[0] as never)).resolves.toEqual({
      departmentManagerIds: ['mgr'],
      adminIds: ['admin'],
      superManagerIds: ['sm'],
      superAdminIds: ['sa'],
    });
    await expect(svc.departmentsWithManager(['d1', 'd2', null])).resolves.toEqual(new Set(['d1']));
  });

  it('says who a pending request waits on', async () => {
    const { svc } = setup();
    await expect(
      svc.waitingFor([
        { approverRole: 'MANAGER', userId: 'staff' },
        { approverRole: 'MANAGER', userId: 'other' },
        { approverRole: 'ADMIN', userId: 'mgr' },
        { approverRole: null, userId: 'staff' },
      ]),
    ).resolves.toEqual([
      'the Dept d1 managers',
      'the organisation admin',
      'the organisation admin',
      null,
    ]);
  });
});
