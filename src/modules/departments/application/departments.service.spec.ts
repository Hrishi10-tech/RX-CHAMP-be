import { Prisma } from '@prisma/client';
import {
  DEPT_A1,
  DEPT_A2,
  DEPT_B1,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { DepartmentsService } from './departments.service';

interface Dept {
  id: string;
  companyId: string;
  name: string;
  icon: string;
  createdAt: Date;
  deletedAt: Date | null;
}

function setup(depts: Dept[] = [], activeStaff: Record<string, number> = {}) {
  const store = depts.map((d) => ({ ...d }));
  const calls: { model: string; op: string; args: any }[] = [];
  const pick = (d: Dept) => ({ id: d.id, name: d.name, icon: d.icon, createdAt: d.createdAt });
  const matches = (d: Dept, where: any) =>
    (where.companyId === undefined || d.companyId === where.companyId) &&
    (where.deletedAt !== null || d.deletedAt === null) &&
    (where.id === undefined ||
      (typeof where.id === 'string' ? d.id === where.id : where.id.in.includes(d.id)));
  const tx: any = {
    // The organisation's row lock (SELECT ... FOR UPDATE): found unless a test says otherwise.
    $queryRaw: jest.fn(async () => [{ id: 'org' }]),
    department: {
      create: jest.fn(async ({ data }: any) => {
        calls.push({ model: 'department', op: 'create', args: data });
        const row = {
          id: '00000000-0000-0000-0000-0000000000a9',
          ...data,
          createdAt: new Date(),
          deletedAt: null,
        };
        store.push(row);
        return pick(row);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        calls.push({ model: 'department', op: 'update', args: { where, data } });
        const row = store.find((d) => d.id === where.id)!;
        Object.assign(row, data);
        return pick(row);
      }),
    },
    user: {
      updateMany: jest.fn(async (args: any) => {
        calls.push({ model: 'user', op: 'updateMany', args });
        return { count: 1 };
      }),
    },
    shiftAssignment: {
      updateMany: jest.fn(async (args: any) => {
        calls.push({ model: 'shiftAssignment', op: 'updateMany', args });
        return { count: 1 };
      }),
    },
    managerDepartment: {
      findMany: jest.fn(async () => [{ managerId: 'mgr-1' }]),
      deleteMany: jest.fn(async (args: any) => {
        calls.push({ model: 'managerDepartment', op: 'deleteMany', args });
        return { count: 1 };
      }),
    },
    auditLog: { create: jest.fn() },
  };
  const prisma: any = {
    department: {
      findMany: jest.fn(async ({ where }: any) => store.filter((d) => matches(d, where)).map(pick)),
      findFirst: jest.fn(async ({ where }: any) => {
        const d = store.find((x) => matches(x, where));
        return d ? pick(d) : null;
      }),
    },
    user: {
      count: jest.fn(async ({ where }: any) => activeStaff[where.departmentId] ?? 0),
      groupBy: jest.fn(async () => []),
    },
    managerDepartment: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const settings = { readRaw: jest.fn(async () => ({})) };
  const idle = { removeDepartment: jest.fn() };
  const days = { invalidate: jest.fn() };
  const audit = { record: jest.fn() };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const service = new DepartmentsService(
    prisma,
    settings as any,
    idle as any,
    days as any,
    audit as any,
    events as any,
  );
  return { service, prisma, tx, calls, idle, days, events, store };
}

const at = new Date('2026-10-01T00:00:00Z');
const dept = (id: string, companyId: string, name: string): Dept => ({
  id,
  companyId,
  name,
  icon: 'code',
  createdAt: at,
  deletedAt: null,
});
const ALL = [
  dept(DEPT_A1, ORG_A, 'Electronics'),
  dept(DEPT_A2, ORG_A, 'Sales'),
  dept(DEPT_B1, ORG_B, 'Support'),
];

describe('DepartmentsService scope', () => {
  it('Admin lists every department of their organisation only', async () => {
    const { service } = setup(ALL);
    expect((await service.list(admin(ORG_A))).map((d) => d.name)).toEqual(['Electronics', 'Sales']);
    expect((await service.list(admin(ORG_B))).map((d) => d.name)).toEqual(['Support']);
  });

  it('Super Admin lists the selected organisation, and needs one', async () => {
    const { service } = setup(ALL);
    expect((await service.list(superAdmin(ORG_B))).map((d) => d.name)).toEqual(['Support']);
    await expect(service.list(superAdmin(null))).rejects.toMatchObject({
      status: 400,
      code: 'ORG_REQUIRED',
    });
  });

  it('Manager lists only their departments; none when they have none', async () => {
    const { service } = setup(ALL);
    expect((await service.list(manager([DEPT_A2]))).map((d) => d.name)).toEqual(['Sales']);
    expect(await service.list(manager([]))).toEqual([]);
  });

  it('Staff cannot list departments', async () => {
    const { service } = setup(ALL);
    await expect(service.list(staff())).rejects.toMatchObject({ status: 403 });
  });

  it('Managers and Staff cannot create, rename or delete', async () => {
    const { service } = setup(ALL);
    for (const me of [manager([DEPT_A1]), staff()]) {
      await expect(service.create(me, { name: 'New', icon: 'code' })).rejects.toMatchObject({
        status: 403,
      });
      await expect(service.update(me, DEPT_A1, { name: 'X' })).rejects.toMatchObject({
        status: 403,
      });
      await expect(service.remove(me, DEPT_A1)).rejects.toMatchObject({ status: 403 });
    }
  });

  it("another organisation's department is not found (404)", async () => {
    const { service } = setup(ALL);
    await expect(service.update(admin(ORG_A), DEPT_B1, { icon: 'cpu' })).rejects.toMatchObject({
      status: 404,
      code: 'DEPARTMENT_NOT_FOUND',
    });
    await expect(service.remove(superAdmin(ORG_A), DEPT_B1)).rejects.toMatchObject({ status: 404 });
  });
});

describe('DepartmentsService rules', () => {
  it('creates in the caller organisation with a normalised name', async () => {
    const { service, calls } = setup(ALL);
    const view = await service.create(admin(ORG_A), {
      name: '  Quality   Assurance ',
      icon: 'badge-check',
    });
    expect(calls[0].args).toEqual({
      companyId: ORG_A,
      name: 'Quality Assurance',
      icon: 'badge-check',
    });
    expect(view).toMatchObject({
      name: 'Quality Assurance',
      staffCount: 0,
      managers: [],
      idle: { enabled: null },
    });
  });

  it('refuses a duplicate name ignoring case and spacing (409 DEPARTMENT_EXISTS)', async () => {
    const { service } = setup(ALL);
    await expect(
      service.create(admin(ORG_A), { name: ' sales ', icon: 'code' }),
    ).rejects.toMatchObject({
      status: 409,
      code: 'DEPARTMENT_EXISTS',
    });
  });

  it('allows the same name in another organisation', async () => {
    const { service } = setup(ALL);
    await expect(
      service.create(admin(ORG_B), { name: 'Sales', icon: 'code' }),
    ).resolves.toMatchObject({
      name: 'Sales',
    });
  });

  it('locks the organisation first; a deleted one gets no department (404 ORG_NOT_FOUND)', async () => {
    const { service, tx } = setup(ALL);
    await service.create(admin(ORG_A), { name: 'Logistics', icon: 'truck' });
    expect(tx.$queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.department.create.mock.invocationCallOrder[0],
    );
    tx.$queryRaw.mockResolvedValueOnce([]);
    tx.department.create.mockClear();
    await expect(
      service.create(admin(ORG_A), { name: 'Freight', icon: 'truck' }),
    ).rejects.toMatchObject({ status: 404, code: 'ORG_NOT_FOUND' });
    expect(tx.department.create).not.toHaveBeenCalled();
  });

  it('maps the unique index (a race) to 409 DEPARTMENT_EXISTS', async () => {
    const { service, tx } = setup(ALL);
    tx.department.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
    );
    await expect(
      service.create(admin(ORG_A), { name: 'Logistics', icon: 'truck' }),
    ).rejects.toMatchObject({
      code: 'DEPARTMENT_EXISTS',
    });
  });

  it('refuses unknown icons and empty or long names', async () => {
    const { service } = setup(ALL);
    await expect(service.create(admin(), { name: 'Ops', icon: 'skull' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.create(admin(), { name: '  ', icon: 'code' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      service.create(admin(), { name: 'z'.repeat(61), icon: 'code' }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('renames people and shift assignments in the same transaction', async () => {
    const { service, calls, days } = setup(ALL);
    await service.update(admin(ORG_A), DEPT_A1, { name: 'Electronics  Lab' });
    const users = calls.find((c) => c.model === 'user')!;
    expect(users.args).toEqual({
      where: { departmentId: DEPT_A1, deletedAt: null },
      data: { department: 'Electronics Lab' },
    });
    const assignments = calls.find((c) => c.model === 'shiftAssignment')!;
    expect(assignments.args).toEqual({
      where: { target: 'DEPARTMENT', companyId: ORG_A, departmentKey: 'electronics' },
      data: { department: 'Electronics Lab', departmentKey: 'electronics lab' },
    });
    expect(days.invalidate).toHaveBeenCalled();
  });

  it('a change of case alone is not a clash with itself', async () => {
    const { service } = setup(ALL);
    await expect(service.update(admin(ORG_A), DEPT_A2, { name: 'SALES' })).resolves.toMatchObject({
      name: 'SALES',
    });
  });

  it('an icon change leaves people and assignments alone', async () => {
    const { service, calls } = setup(ALL);
    await service.update(admin(ORG_A), DEPT_A1, { icon: 'cpu' });
    expect(calls.map((c) => c.model)).toEqual(['department']);
  });

  it('refuses to delete while active staff are in it (409 DEPARTMENT_NOT_EMPTY)', async () => {
    const { service } = setup(ALL, { [DEPT_A1]: 3 });
    await expect(service.remove(admin(ORG_A), DEPT_A1)).rejects.toMatchObject({
      status: 409,
      code: 'DEPARTMENT_NOT_EMPTY',
      details: { staff: 3 },
    });
  });

  it('deletes softly, unassigns managers, drops its input tracking entry and tells the managers sockets', async () => {
    const { service, calls, idle, events, store } = setup(ALL);
    await expect(service.remove(admin(ORG_A), DEPT_A2)).resolves.toEqual({
      deleted: true,
      id: DEPT_A2,
    });
    expect(calls.find((c) => c.model === 'managerDepartment')!.args).toEqual({
      where: { departmentId: DEPT_A2 },
    });
    expect(store.find((d) => d.id === DEPT_A2)!.deletedAt).toBeInstanceOf(Date);
    expect(idle.removeDepartment).toHaveBeenCalledWith(ORG_A, DEPT_A2, admin(ORG_A).id);
    expect(events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ userId: 'mgr-1', changes: ['ROLE'] }),
    );
  });
});
