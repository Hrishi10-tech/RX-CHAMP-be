// Super Manager accounts (3.3 on 4.0): a Super Admin alone lists and adds them;
// the account belongs to no organisation, department or grants.
import { Role } from '@shared/rbac/roles.enum';
import { IDS, ORG_A, admin, superAdmin, superManager } from '@shared/testing/actors.testing-spec';
import { person } from '../../testing/people.testing-spec';
import { SuperManagersUseCase } from './super-managers.use-case';

const ROW = {
  firstName: 'Asha',
  lastName: 'Raman',
  email: ' Asha@Example.test',
  password: 'S3cure!pass',
};

function setup(existingEmail?: string) {
  const users = {
    findByEmail: jest.fn(async (email: string) =>
      email === existingEmail ? person({ email }) : null,
    ),
    findAll: jest.fn(async () => [
      person({
        id: IDS.superManager,
        role: Role.SUPER_MANAGER,
        companyId: null,
        departmentId: null,
      }),
    ]),
    create: jest.fn(async (data: any) =>
      person({
        id: IDS.superManager,
        email: data.email,
        role: data.role,
        companyId: data.companyId ?? null,
        departmentId: data.departmentId ?? null,
      }),
    ),
  };
  const hasher = { hash: jest.fn(async () => 'hashed'), compare: jest.fn() };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const audit = { record: jest.fn() };
  const useCase = new SuperManagersUseCase(users as any, hasher, events as any, audit as any);
  return { useCase, users, events, audit };
}

describe('SuperManagersUseCase', () => {
  it.each([
    ['a Super Admin on the platform view', superAdmin(null)],
    ['a Super Admin inside an organisation', superAdmin(ORG_A)],
  ])('%s adds a Super Manager with no organisation, department or grants', async (_w, me) => {
    const { useCase, users, events, audit } = setup();
    const created = await useCase.create(me, ROW);
    const data = users.create.mock.calls[0][0];
    expect(data).toMatchObject({
      email: 'asha@example.test',
      passwordHash: 'hashed',
      role: Role.SUPER_MANAGER,
      departmentId: null,
      managedDepartmentIds: [],
    });
    expect(data.companyId).toBeUndefined();
    expect(data.grants).toBeUndefined();
    expect(created).toMatchObject({ role: Role.SUPER_MANAGER, companyId: null });
    expect(events.publish).toHaveBeenCalledWith('user.created', expect.anything());
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'USER_CREATED',
        metadata: expect.objectContaining({ role: Role.SUPER_MANAGER }),
      }),
    );
  });

  it.each([
    ['an Admin', admin(ORG_A)],
    ['the Super Manager', superManager(ORG_A)],
  ])('refuses %s (403)', async (_w, me) => {
    const { useCase, users } = setup();
    await expect(useCase.create(me, ROW)).rejects.toMatchObject({ status: 403 });
    await expect(useCase.list(me)).rejects.toMatchObject({ status: 403 });
    expect(users.create).not.toHaveBeenCalled();
  });

  it('checks the fields and the email (400 / 409 EMAIL_IN_USE)', async () => {
    const { useCase } = setup('asha@example.test');
    await expect(useCase.create(superAdmin(), { ...ROW, firstName: ' ' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(useCase.create(superAdmin(), { ...ROW, email: 'nope' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(useCase.create(superAdmin(), { ...ROW, password: 'short' })).rejects.toMatchObject(
      { status: 400, code: 'WEAK_PASSWORD' },
    );
    await expect(useCase.create(superAdmin(), ROW)).rejects.toMatchObject({
      status: 409,
      code: 'EMAIL_IN_USE',
    });
  });

  it('lists Super Manager accounts only', async () => {
    const { useCase, users } = setup();
    const list = await useCase.list(superAdmin());
    expect(users.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ roles: [Role.SUPER_MANAGER] }),
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ role: Role.SUPER_MANAGER, companyId: null });
  });
});
