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
import { cast, fakeDepartments, fakeUsers, person } from '../../testing/people.testing-spec';
import { UpdateUserUseCase } from './update-user.use-case';

function setup(extra: ReturnType<typeof person>[] = []) {
  const people = cast();
  const users = fakeUsers([...Object.values(people), ...extra]);
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const audit = { record: jest.fn(), recordMany: jest.fn() };
  const useCase = new UpdateUserUseCase(
    users as any,
    fakeDepartments(),
    events as any,
    audit as any,
  );
  return { useCase, users, events, audit, people };
}

const actions = (audit: { recordMany: jest.Mock }) =>
  (audit.recordMany.mock.calls.at(-1)?.[0] ?? []).map((e: { action: string }) => e.action);

describe('UpdateUserUseCase: scope', () => {
  it('anyone may rename themselves, nothing more', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(staff(), IDS.staffA1, { firstName: 'Janet' }),
    ).resolves.toMatchObject({
      firstName: 'Janet',
    });
    await expect(
      useCase.execute(staff(), IDS.staffA1, { departmentId: DEPT_A2 }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      useCase.execute(admin(ORG_A), IDS.adminA, { email: 'x@acme.test' }),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('Managers change nobody: 403 for their Staff, 404 for others', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(manager([DEPT_A1]), IDS.staffA1, { firstName: 'X' }),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      useCase.execute(manager([DEPT_A1]), IDS.staffA2, { firstName: 'X' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('another organisation answers 404', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(ORG_A), IDS.staffB1, { firstName: 'X' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      useCase.execute(superAdmin(ORG_A), IDS.adminB, { firstName: 'X' }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("a Super Admin edits the organisation's Admin but never their role or departments", async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(superAdmin(ORG_A), IDS.adminA, { lastName: 'Raman' }),
    ).resolves.toMatchObject({
      lastName: 'Raman',
    });
    await expect(
      useCase.execute(superAdmin(ORG_A), IDS.adminA, { role: Role.MANAGER }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'ADMIN_ROLE_FIXED',
    });
  });
});

describe('UpdateUserUseCase: departments, roles, grants', () => {
  it('moves Staff to another department: name follows, sockets refresh, audited', async () => {
    const { useCase, events, audit } = setup();
    const res = await useCase.execute(admin(ORG_A), IDS.staffA1, { departmentId: DEPT_A2 });
    expect(res).toMatchObject({ departmentId: DEPT_A2, department: 'Sales' });
    expect(events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ userId: IDS.staffA1, changes: ['ROLE'] }),
    );
    expect(actions(audit)).toEqual(['USER_DEPARTMENT_CHANGED']);
  });

  it("refuses another organisation's department (404)", async () => {
    const { useCase, users } = setup();
    await expect(
      useCase.execute(admin(ORG_A), IDS.staffA1, { departmentId: DEPT_B1 }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'DEPARTMENT_NOT_FOUND',
    });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('Staff -> Manager: manages their department unless told otherwise; grants apply', async () => {
    const { useCase, audit } = setup();
    const res = await useCase.execute(admin(ORG_A), IDS.staffA2, {
      role: Role.MANAGER,
      grants: { timeline: true },
    });
    expect(res).toMatchObject({
      role: Role.MANAGER,
      departmentId: DEPT_A2,
      departments: [{ id: DEPT_A2, name: 'Sales', icon: 'bar-chart' }],
      grants: { screenshots: false, timeline: true, activity: false },
    });
    expect(actions(audit)).toEqual([
      'USER_ROLE_CHANGED',
      'USER_DEPARTMENT_CHANGED',
      'USER_GRANTS_CHANGED',
    ]);
  });

  it('Manager -> Staff: keeps one department, loses managed departments and grants', async () => {
    const mgr = person({
      id: '20000000-0000-0000-0000-0000000000a5',
      role: Role.MANAGER,
      departmentId: DEPT_A1,
      managed: [DEPT_A1, DEPT_A2],
      grants: { screenshots: true, timeline: true, activity: true },
    });
    const { useCase } = setup([mgr]);
    const res = await useCase.execute(admin(ORG_A), mgr.id, { role: Role.USER });
    expect(res).toMatchObject({
      role: Role.USER,
      departmentId: DEPT_A1,
      departments: [],
      grants: { screenshots: false, timeline: false, activity: false },
    });
  });

  it('a Manager keeps at least one department', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(ORG_A), IDS.managerA1, { departmentIds: [] }),
    ).rejects.toMatchObject({
      code: 'DEPARTMENTS_REQUIRED',
    });
  });

  it('Admin is never a role given here', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(admin(ORG_A), IDS.staffA1, { role: 'ADMIN' as Role }),
    ).rejects.toMatchObject({ code: 'ROLE_NOT_ALLOWED' });
  });

  it('a name or designation change does not touch live access', async () => {
    const { useCase, events } = setup();
    await useCase.execute(admin(ORG_A), IDS.managerA1, { designation: 'Lead', firstName: 'Maya' });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('an email in use elsewhere answers 409 EMAIL_IN_USE; a change is audited', async () => {
    const { useCase, people, audit } = setup();
    await expect(
      useCase.execute(admin(ORG_A), IDS.staffA1, { email: people.staffB1.email }),
    ).rejects.toMatchObject({ status: 409, code: 'EMAIL_IN_USE' });
    await useCase.execute(admin(ORG_A), IDS.staffA2, { email: 'fresh@acme.test' });
    expect(actions(audit)).toEqual(['USER_EMAIL_CHANGED']);
  });

  it('works the same for a Super Admin inside the organisation', async () => {
    const { useCase } = setup();
    await expect(
      useCase.execute(superAdmin(ORG_A), IDS.staffA1, { departmentId: DEPT_A2 }),
    ).resolves.toMatchObject({ departmentId: DEPT_A2 });
    await expect(
      useCase.execute(superAdmin(ORG_B), IDS.staffA1, { departmentId: DEPT_A2 }),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});
