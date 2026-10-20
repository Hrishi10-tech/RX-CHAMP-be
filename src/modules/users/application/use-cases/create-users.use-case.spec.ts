// CreateUsersUseCase (docs/4.0/SPEC.md 5.3): Admin and Super Admin add Managers and
// Staff to their organisation; departments must be the organisation's; the body
// never chooses the organisation; bulk rows are reported one by one.
import { Role } from '@shared/rbac/roles.enum';
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
import { User } from '../../domain/entities/user.entity';
import { fakeDepartments, person } from '../../testing/people.testing-spec';
import { CreateUsersUseCase } from './create-users.use-case';

const PASSWORD = 'S3cure!pass';
const STAFF_ROW = {
  firstName: 'New',
  lastName: 'Person',
  email: 'New.Person@Acme.test ',
  password: PASSWORD,
  role: 'USER',
  departmentId: DEPT_A1,
};

function setup(existing: User[] = []) {
  const users = {
    findByEmail: jest.fn(async (email: string) => existing.find((u) => u.email === email) ?? null),
    findById: jest.fn(),
    create: jest.fn(async (data: any) =>
      person({
        id: '40000000-0000-0000-0000-000000000001',
        email: data.email,
        role: data.role,
        companyId: data.companyId,
        departmentId: data.departmentId,
        managed: data.managedDepartmentIds,
        grants: data.grants,
      }),
    ),
    save: jest.fn(async (u: User) => u),
  };
  const shifts = {
    findById: jest.fn(async (id: string) =>
      id === '50000000-0000-0000-0000-00000000000a'
        ? { id, start: '09:00', end: '18:00', companyId: ORG_A }
        : id === '50000000-0000-0000-0000-00000000000b'
          ? { id, start: '09:00', end: '18:00', companyId: ORG_B }
          : id === '50000000-0000-0000-0000-00000000000c'
            ? { id, start: '08:00', end: '17:00' }
            : null,
    ),
    companyExists: jest.fn(),
  };
  const departments = fakeDepartments();
  const hasher = { hash: jest.fn(async () => 'hashed'), compare: jest.fn() };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const audit = { record: jest.fn() };
  const useCase = new CreateUsersUseCase(
    users as any,
    shifts as any,
    departments,
    hasher,
    events as any,
    audit as any,
  );
  return { useCase, users, shifts, departments, hasher, events, audit };
}

describe('CreateUsersUseCase: who may add people', () => {
  it.each([
    ['a Manager', manager([DEPT_A1])],
    ['Staff', staff()],
  ])('refuses %s (403)', async (_who, me) => {
    const { useCase, users } = setup();
    await expect(useCase.execute(me, [STAFF_ROW], true)).rejects.toMatchObject({ status: 403 });
    expect(users.create).not.toHaveBeenCalled();
  });

  it('needs a Super Admin to pick an organisation first (400 ORG_REQUIRED)', async () => {
    const { useCase } = setup();
    await expect(useCase.execute(superAdmin(null), [STAFF_ROW], true)).rejects.toMatchObject({
      code: 'ORG_REQUIRED',
    });
  });

  it("puts people in the caller's organisation whatever the body says", async () => {
    const { useCase, users } = setup();
    await useCase.execute(superAdmin(ORG_A), [{ ...STAFF_ROW, companyId: ORG_B } as any], true);
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({ companyId: ORG_A }));
  });
});

describe('CreateUsersUseCase: Staff', () => {
  it('creates Staff in one department, with its name as users.department', async () => {
    const { useCase, users, events, audit } = setup();
    const { created, errors } = await useCase.execute(admin(ORG_A), [STAFF_ROW], true);
    expect(errors).toEqual([]);
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'new.person@acme.test',
        passwordHash: 'hashed',
        role: Role.USER,
        departmentId: DEPT_A1,
        department: 'Electronics',
        managedDepartmentIds: [],
        grants: { screenshots: false, timeline: false, activity: false },
        companyId: ORG_A,
        createdById: IDS.adminA,
      }),
    );
    expect(created[0]).toMatchObject({
      role: Role.USER,
      departmentId: DEPT_A1,
      department: 'Electronics',
    });
    expect(events.publish).toHaveBeenCalledWith('user.created', expect.anything());
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'USER_CREATED' }));
  });

  it('needs a department (400 DEPARTMENT_REQUIRED)', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(ORG_A), [{ ...STAFF_ROW, departmentId: undefined }], true),
    ).rejects.toMatchObject({ status: 400, code: 'DEPARTMENT_REQUIRED' });
  });

  it("refuses another organisation's department (404 DEPARTMENT_NOT_FOUND)", async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(ORG_A), [{ ...STAFF_ROW, departmentId: DEPT_B1 }], true),
    ).rejects.toMatchObject({ status: 404, code: 'DEPARTMENT_NOT_FOUND' });
  });

  it('refuses grants for Staff and several departments', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(), [{ ...STAFF_ROW, grants: { screenshots: true } }], true),
    ).rejects.toMatchObject({ code: 'GRANTS_MANAGERS_ONLY' });
    await expect(
      useCase.execute(admin(), [{ ...STAFF_ROW, departmentIds: [DEPT_A1, DEPT_A2] }], true),
    ).rejects.toMatchObject({ code: 'STAFF_ONE_DEPARTMENT' });
  });
});

describe('CreateUsersUseCase: Managers', () => {
  const row = { ...STAFF_ROW, role: 'MANAGER', departmentId: undefined };

  it('needs at least one department (400 DEPARTMENTS_REQUIRED)', async () => {
    const { useCase } = setup();
    await expect(useCase.execute(admin(), [row], true)).rejects.toMatchObject({
      code: 'DEPARTMENTS_REQUIRED',
    });
  });

  it('creates a Manager over their departments with grants; their own department defaults to the first', async () => {
    const { useCase, users } = setup();
    await useCase.execute(
      admin(),
      [
        {
          ...row,
          departmentIds: [DEPT_A2, DEPT_A1],
          grants: { screenshots: true, activity: true },
        },
      ],
      true,
    );
    expect(users.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role: Role.MANAGER,
        departmentId: DEPT_A2,
        department: 'Sales',
        managedDepartmentIds: [DEPT_A2, DEPT_A1],
        grants: { screenshots: true, timeline: false, activity: true },
      }),
    );
  });

  it("refuses a department of another organisation among the Manager's", async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(), [{ ...row, departmentIds: [DEPT_A1, DEPT_B1] }], true),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('never creates an Admin or a Super Admin here (400 ROLE_NOT_ALLOWED)', async () => {
    const { useCase } = setup();
    for (const role of ['ADMIN', 'SUPER_ADMIN', 'OWNER']) {
      await expect(useCase.execute(admin(), [{ ...STAFF_ROW, role }], true)).rejects.toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
    }
  });
});

describe('CreateUsersUseCase: email, shift, bulk', () => {
  it('reports an address in use without saying where (409 EMAIL_IN_USE)', async () => {
    const elsewhere = person({
      id: IDS.staffB1,
      email: 'new.person@acme.test',
      companyId: ORG_B,
      departmentId: DEPT_B1,
    });
    const { useCase } = setup([elsewhere]);
    const err = await useCase.execute(admin(ORG_A), [STAFF_ROW], true).catch((e) => e);
    expect(err).toMatchObject({
      status: 409,
      code: 'EMAIL_IN_USE',
      message: 'That email address is already in use.',
    });
  });

  it('still refuses when that account is blocked in another organisation', async () => {
    const blocked = person({
      email: 'new.person@acme.test',
      companyId: ORG_B,
      departmentId: DEPT_B1,
      status: 'DISABLED',
    });
    const { useCase } = setup([blocked]);
    await expect(useCase.execute(admin(ORG_A), [STAFF_ROW], true)).rejects.toMatchObject({
      code: 'EMAIL_IN_USE',
    });
  });

  it('reactivates a blocked account of the same organisation with the new details', async () => {
    const blocked = person({
      email: 'new.person@acme.test',
      departmentId: DEPT_A2,
      status: 'DISABLED',
    });
    const { useCase, users, hasher, events } = setup([blocked]);
    const { created } = await useCase.execute(admin(ORG_A), [STAFF_ROW], true);
    expect(users.create).not.toHaveBeenCalled();
    expect(users.save).toHaveBeenCalled();
    expect(hasher.hash).toHaveBeenCalledWith(PASSWORD);
    expect(created[0]).toMatchObject({
      status: 'ACTIVE',
      departmentId: DEPT_A1,
      department: 'Electronics',
    });
    expect(events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ active: true }),
    );
  });

  it('never turns a blocked Admin into a Manager or Staff member', async () => {
    const blockedAdmin = person({
      email: 'new.person@acme.test',
      role: Role.ADMIN,
      departmentId: null,
      status: 'DISABLED',
    });
    const { useCase } = setup([blockedAdmin]);
    await expect(useCase.execute(superAdmin(ORG_A), [STAFF_ROW], true)).rejects.toMatchObject({
      code: 'EMAIL_IN_USE',
    });
  });

  it("takes the organisation's or a shared legacy shift, not another organisation's", async () => {
    const { useCase, users } = setup();
    await useCase.execute(
      admin(ORG_A),
      [{ ...STAFF_ROW, shiftId: '50000000-0000-0000-0000-00000000000a' }],
      true,
    );
    expect(users.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        shiftId: '50000000-0000-0000-0000-00000000000a',
        shiftStart: '09:00',
      }),
    );
    await useCase.execute(
      admin(ORG_A),
      [{ ...STAFF_ROW, shiftId: '50000000-0000-0000-0000-00000000000c' }],
      true,
    );
    expect(users.create).toHaveBeenLastCalledWith(expect.objectContaining({ shiftStart: '08:00' }));
    await expect(
      useCase.execute(
        admin(ORG_A),
        [{ ...STAFF_ROW, shiftId: '50000000-0000-0000-0000-00000000000b' }],
        true,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'SHIFT_NOT_FOUND' });
  });

  it('validates required fields and the password length', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(), [{ ...STAFF_ROW, lastName: '' }], true),
    ).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      useCase.execute(admin(), [{ ...STAFF_ROW, password: 'short' }], true),
    ).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    });
    await expect(
      useCase.execute(admin(), [{ ...STAFF_ROW, email: 'not-an-email' }], true),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('bulk: one bad row never fails the batch', async () => {
    const { useCase } = setup();
    const { created, errors } = await useCase.execute(admin(ORG_A), [
      STAFF_ROW,
      { ...STAFF_ROW, email: 'second@acme.test', departmentId: DEPT_B1 },
      { ...STAFF_ROW, email: 'third@acme.test', password: 'x' },
    ]);
    expect(created).toHaveLength(1);
    expect(errors).toEqual([
      { email: 'second@acme.test', error: 'That department does not exist in this organisation.' },
      { email: 'third@acme.test', error: 'Use a password of 8 to 128 characters.' },
    ]);
  });
});
