// 4.0 tenancy of shifts, shift assignments and team breaks (docs/4.0/SPEC.md 1.2:
// "Shifts, assignments: Admin/SA org, Manager read"; "Team breaks: org, my depts").
import {
  DEPT_A1,
  DEPT_A2,
  DEPT_B1,
  IDS,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { ShiftRecord } from '../../domain/shift.types';
import { ManageShiftsUseCase } from './manage-shifts.use-case';
import { ShiftAssignmentsUseCase } from './shift-assignments.use-case';
import { TeamBreaksUseCase } from './team-breaks.use-case';

const SHIFT_A = '70000000-0000-0000-0000-0000000000a1';
const SHIFT_B = '70000000-0000-0000-0000-0000000000b1';
const SHIFT_SHARED = '70000000-0000-0000-0000-000000000005';

function shift(id: string, companyId: string | null, name: string): ShiftRecord {
  return {
    id,
    companyId,
    name,
    start: '09:00',
    end: '18:00',
    workDays: [1, 2, 3, 4, 5, 6],
    ringLeadMin: 1,
    ringDurationMin: 5,
    ringSound: true,
    reasonOnEarly: true,
    reasonOnLate: true,
    reasonMinChars: 10,
    overrunReason: false,
    overrunGraceMin: 3,
    breaks: [],
    isDefault: false,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  } as ShiftRecord;
}

function deps() {
  const all = [
    shift(SHIFT_A, ORG_A, 'Day A'),
    shift(SHIFT_B, ORG_B, 'Day B'),
    shift(SHIFT_SHARED, null, 'Shared'),
  ];
  const shifts = {
    list: jest.fn(async () => all),
    findById: jest.fn(async (id: string) => all.find((s) => s.id === id) ?? null),
    findByName: jest.fn(async () => null),
    create: jest.fn(async (data: any) => ({
      ...shift('70000000-0000-0000-0000-0000000000a2', data.companyId, data.name),
    })),
    update: jest.fn(),
    createUnique: jest.fn(async (data: { companyId: string | null; name: string }) => ({
      ok: true,
      shift: shift('70000000-0000-0000-0000-0000000000a2', data.companyId, data.name),
    })),
    updateUnique: jest.fn(async (id: string, data: { companyId: string | null; name: string }) => ({
      ok: true,
      shift: shift(id, data.companyId, data.name),
    })),
    softDelete: jest.fn(),
    setDefault: jest.fn(),
    listDefaults: jest.fn(async () => []),
    usage: jest.fn(async () => ({ activeAssignments: 0 })),
    applyAssignments: jest.fn(),
  };
  shifts.findById.mockImplementation(async (id: string) => {
    const created = shifts.createUnique.mock.results.at(-1);
    if (created && id === '70000000-0000-0000-0000-0000000000a2')
      return (await created.value).shift;
    return all.find((s) => s.id === id) ?? null;
  });
  const people = {
    findMany: jest.fn(async () => []),
    count: jest.fn(async () => 0),
    findById: jest.fn(async () => null),
    listDepartments: jest.fn(async () => []),
    findAnyByIds: jest.fn(async () => []),
  };
  const days = {
    timezone: 'Asia/Kolkata',
    invalidate: jest.fn(),
    context: jest.fn(async () => ({ assignments: [], shiftsById: new Map(), defaults: [] })),
    resolveWith: jest.fn(() => ({ shift: null, source: 'NONE' })),
    forDate: jest.fn(() => ({
      slots: [],
      resolved: { shift: null, source: 'NONE' },
      workday: true,
    })),
  };
  return { shifts, people, days };
}

const DTO = {
  name: 'Evening',
  start: '14:00',
  end: '23:00',
  workDays: [1, 2, 3, 4, 5],
  breaks: [],
  companyId: ORG_B,
} as any;

describe('ManageShiftsUseCase scope', () => {
  const make = () => {
    const d = deps();
    return {
      ...d,
      useCase: new ManageShiftsUseCase(d.shifts as any, d.people as any, d.days as any),
    };
  };

  it("lists the organisation's and shared shifts, never another organisation's", async () => {
    const { useCase, people } = make();
    for (const me of [admin(ORG_A), superAdmin(ORG_A), manager([DEPT_A1])]) {
      expect((await useCase.list(me)).map((s) => s.id)).toEqual([SHIFT_A, SHIFT_SHARED]);
    }
    expect(people.findMany).toHaveBeenCalledWith({ companyId: ORG_A });
    await expect(useCase.get(admin(ORG_A), SHIFT_B)).rejects.toMatchObject({ status: 404 });
  });

  it('Staff cannot, and a Super Admin needs an organisation', async () => {
    const { useCase } = make();
    await expect(useCase.list(staff())).rejects.toMatchObject({ status: 403 });
    await expect(useCase.list(superAdmin(null))).rejects.toMatchObject({ code: 'ORG_REQUIRED' });
  });

  it("creates in the caller's organisation whatever the body says; Managers cannot", async () => {
    const { useCase, shifts } = make();
    await useCase.create(admin(ORG_A), DTO);
    // One locked check-and-insert per organisation (it also makes a first shift the default).
    expect(shifts.createUnique).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: ORG_A, name: 'Evening' }),
    );
    expect(shifts.create).not.toHaveBeenCalled();
    await expect(useCase.create(manager([DEPT_A1]), DTO)).rejects.toMatchObject({ status: 403 });
  });

  it('a name the organisation already has is refused (409), however close two requests come', async () => {
    const { useCase, shifts, days } = make();
    shifts.createUnique.mockResolvedValueOnce({ ok: false } as never);
    await expect(useCase.create(admin(ORG_A), DTO)).rejects.toMatchObject({ status: 409 });
    shifts.updateUnique.mockResolvedValueOnce({ ok: false } as never);
    await expect(useCase.update(admin(ORG_A), SHIFT_A, DTO)).rejects.toMatchObject({ status: 409 });
    // The check lives inside the locked write, never as a separate read before it.
    expect(shifts.findByName).not.toHaveBeenCalled();
    expect(days.invalidate).not.toHaveBeenCalled();
  });

  it('shared shifts are read-only to Admins and editable by a Super Admin', async () => {
    const { useCase, shifts } = make();
    await expect(useCase.update(admin(ORG_A), SHIFT_SHARED, DTO)).rejects.toMatchObject({
      status: 403,
      code: 'SHIFT_SHARED',
    });
    await expect(useCase.makeDefault(admin(ORG_A), SHIFT_SHARED)).rejects.toMatchObject({
      status: 403,
    });
    await useCase.update(superAdmin(ORG_A), SHIFT_SHARED, DTO);
    expect(shifts.updateUnique).toHaveBeenCalledWith(
      SHIFT_SHARED,
      expect.objectContaining({ companyId: null }),
    );
  });

  it("another organisation's shift cannot be changed (404)", async () => {
    const { useCase, shifts } = make();
    await expect(useCase.update(admin(ORG_A), SHIFT_B, DTO)).rejects.toMatchObject({ status: 404 });
    await expect(useCase.remove(superAdmin(ORG_A), SHIFT_B)).rejects.toMatchObject({ status: 404 });
    expect(shifts.softDelete).not.toHaveBeenCalled();
  });
});

describe('ShiftAssignmentsUseCase scope', () => {
  const make = () => {
    const d = deps();
    return {
      ...d,
      useCase: new ShiftAssignmentsUseCase(d.shifts as any, d.people as any, d.days as any),
    };
  };
  const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

  it('Admin reads the organisation; a Manager the Staff of their departments', async () => {
    const { useCase, people } = make();
    await useCase.listPeople(admin(ORG_A), {});
    expect(people.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: ORG_A }));
    await useCase.listPeople(manager([DEPT_A1, DEPT_A2]), {});
    expect(people.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        companyId: ORG_A,
        roles: ['USER'],
        departmentIds: [DEPT_A1, DEPT_A2],
      }),
    );
    await useCase.listDepartments(manager([]));
    expect(people.findMany).toHaveBeenLastCalledWith({
      companyId: ORG_A,
      roles: ['USER'],
      departmentIds: [],
    });
    expect(people.listDepartments).toHaveBeenLastCalledWith(ORG_A);
  });

  it('Managers read only; Staff nothing', async () => {
    const { useCase } = make();
    await expect(
      useCase.assignPeople(manager([DEPT_A1]), {
        userIds: [IDS.staffA1],
        shiftId: SHIFT_A,
        effectiveFrom: tomorrow,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      useCase.assignDepartment(manager([DEPT_A1]), {
        department: 'Electronics',
        shiftId: SHIFT_A,
        effectiveFrom: tomorrow,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(useCase.listPeople(staff(), {})).rejects.toMatchObject({ status: 403 });
  });

  it("assigns only the organisation's people, with its own or a shared shift", async () => {
    const { useCase, people, shifts } = make();
    await expect(
      useCase.assignPeople(admin(ORG_A), {
        userIds: [IDS.staffA1],
        shiftId: SHIFT_B,
        effectiveFrom: tomorrow,
      }),
    ).rejects.toMatchObject({ status: 404 });
    people.findMany.mockResolvedValueOnce([] as never);
    const res = await useCase.assignPeople(admin(ORG_A), {
      userIds: [IDS.staffB1],
      shiftId: SHIFT_SHARED,
      effectiveFrom: tomorrow,
    });
    expect(people.findMany).toHaveBeenLastCalledWith({ ids: [IDS.staffB1], companyId: ORG_A });
    expect(res.skipped).toEqual([{ id: IDS.staffB1, reason: 'Not found or not active' }]);
    expect(shifts.applyAssignments).toHaveBeenCalledWith([]);
  });

  it("puts department shifts in the caller's organisation, ignoring the body", async () => {
    const { useCase, shifts } = make();
    await useCase.assignDepartment(admin(ORG_A), {
      department: '  Electronics ',
      companyId: ORG_B,
      shiftId: SHIFT_A,
      effectiveFrom: tomorrow,
    });
    expect(shifts.applyAssignments).toHaveBeenCalledWith([
      expect.objectContaining({
        companyId: ORG_A,
        department: 'Electronics',
        departmentKey: 'electronics',
      }),
    ]);
  });
});

describe('TeamBreaksUseCase scope', () => {
  const make = (deptInOrg = true) => {
    const d = deps();
    const prisma = {
      department: { count: jest.fn(async () => (deptInOrg ? 1 : 0)) },
      managerDepartment: { findMany: jest.fn(async () => [{ departmentId: DEPT_A2 }]) },
    };
    const records = { listForUsersOnDate: jest.fn(async () => []) };
    return {
      ...d,
      prisma,
      useCase: new TeamBreaksUseCase(records as any, d.people as any, d.days as any, prisma as any),
    };
  };

  it("Admin: the organisation; Manager: their departments' Staff; Staff: refused", async () => {
    const { useCase, people } = make();
    await useCase.execute(admin(ORG_A), {});
    expect(people.findMany).toHaveBeenLastCalledWith({ companyId: ORG_A });
    await useCase.execute(manager([DEPT_A1]), {});
    expect(people.findMany).toHaveBeenLastCalledWith({
      companyId: ORG_A,
      roles: ['USER'],
      departmentIds: [DEPT_A1],
    });
    await expect(useCase.execute(staff(), {})).rejects.toMatchObject({ status: 403 });
  });

  it('filters by a department inside the scope; 404 outside it', async () => {
    const { useCase, people } = make();
    await useCase.execute(manager([DEPT_A1, DEPT_A2]), { departmentId: DEPT_A2 });
    expect(people.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ departmentIds: [DEPT_A2] }),
    );
    await expect(
      useCase.execute(manager([DEPT_A1]), { departmentId: DEPT_A2 }),
    ).rejects.toMatchObject({
      status: 404,
    });
    const other = make(false);
    await expect(
      other.useCase.execute(admin(ORG_A), { departmentId: DEPT_B1 }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("an Admin may narrow to one manager's departments, of their organisation only", async () => {
    const { useCase, people } = make();
    people.findById.mockResolvedValueOnce({
      id: IDS.managerA1,
      role: 'MANAGER',
      companyId: ORG_A,
    } as never);
    await useCase.execute(admin(ORG_A), { managerId: IDS.managerA1 });
    expect(people.findMany).toHaveBeenLastCalledWith({
      companyId: ORG_A,
      roles: ['USER'],
      departmentIds: [DEPT_A2],
    });
    people.findById.mockResolvedValueOnce({
      id: IDS.managerB1,
      role: 'MANAGER',
      companyId: ORG_B,
    } as never);
    await expect(useCase.execute(admin(ORG_A), { managerId: IDS.managerB1 })).rejects.toMatchObject(
      { status: 404 },
    );
  });
});
