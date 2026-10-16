// Unit test for the bulk-create use case — all ports mocked, no DB. Verifies the
// demo's contract: partial success, manager role coercion, dup handling, events.
import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { UnauthorizedAction } from '@shared/exceptions/domain.exception';
import { CreateUsersUseCase } from './create-users.use-case';
import { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';

const makeManager = (): AuthenticatedUser => ({
  id: 'm-1',
  email: 'maya@acme.test',
  role: Role.MANAGER,
  permissions: [],
  department: 'Engineering',
  companyId: 'co-mgr',
  status: 'ACTIVE',
});

function buildEntity(email: string, role = Role.USER): User {
  return User.fromPersistence({
    id: UserId.create('u-new'),
    email: Email.create(email),
    passwordHash: 'h',
    firstName: 'New',
    lastName: 'User',
    designation: null,
    role,
    department: 'Engineering',
    managerId: 'm-1',
    companyId: null,
    companyName: null,
    shiftId: null,
    shiftStart: '10:00',
    shiftEnd: '19:00',
    status: 'ACTIVE',
    screenshotsEnabled: true,
    agentActivatedAt: null,
    createdAt: new Date(),
  });
}

const makeSuperAdmin = (): AuthenticatedUser => ({
  id: 'sa-1',
  email: 'boss@acme.test',
  role: Role.SUPER_ADMIN,
  permissions: [],
  department: null,
  companyId: 'co-hq',
  status: 'ACTIVE',
});

describe('CreateUsersUseCase', () => {
  const usersRepo = {
    findByEmail: jest.fn(),
    findById: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  } as any;
  const shifts = { findById: jest.fn(), companyExists: jest.fn() } as any;
  const roles = {
    findByName: jest.fn().mockResolvedValue({ id: 'role-user', name: Role.USER }),
  } as any;
  const hasher = { hash: jest.fn().mockResolvedValue('hashed'), compare: jest.fn() } as any;
  const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as any;

  const PASSWORD = 'S3cure!pass';
  let useCase: CreateUsersUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    roles.findByName.mockResolvedValue({ id: 'role-user', name: Role.USER });
    shifts.companyExists.mockResolvedValue(true);
    useCase = new CreateUsersUseCase(usersRepo, shifts, roles, hasher, events);
  });

  it('forbids a plain USER from creating users', async () => {
    const me: AuthenticatedUser = { ...makeManager(), role: Role.USER };
    await expect(
      useCase.execute(me, [{ email: 'x@y.z', firstName: 'A', lastName: 'B' }]),
    ).rejects.toBeInstanceOf(UnauthorizedAction);
  });

  it('collects per-item validation errors instead of throwing', async () => {
    const result = await useCase.execute(makeManager(), [
      { email: '', firstName: '', lastName: '' },
    ]);
    expect(result.created).toHaveLength(0);
    expect(result.errors[0].error).toMatch(/required/);
  });

  it('rejects a password shorter than the minimum', async () => {
    const result = await useCase.execute(makeManager(), [
      { email: 'short@acme.test', firstName: 'S', lastName: 'P', password: 'abc', role: Role.USER },
    ]);
    expect(result.errors[0].error).toMatch(/at least 8 characters/);
    expect(usersRepo.create).not.toHaveBeenCalled();
  });

  it('resolves the role by name, forces creator as manager + inherits company, emits event', async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    usersRepo.create.mockResolvedValue(buildEntity('jane@acme.test'));

    const result = await useCase.execute(makeManager(), [
      {
        email: 'jane@acme.test',
        firstName: 'Jane',
        lastName: 'Doe',
        password: PASSWORD,
        role: Role.USER,
        companyId: 'co-ignored',
        managerId: 'someone-else',
      },
    ]);

    // Role resolved by name; managerId = creator; companyId inherited from the manager.
    expect(roles.findByName).toHaveBeenCalledWith(Role.USER);
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        role: Role.USER,
        managerId: 'm-1',
        companyId: 'co-mgr',
        createdById: 'm-1',
      }),
    );
    expect(result.created).toHaveLength(1);
    expect(events.publish).toHaveBeenCalledTimes(1);
    // The provided password is hashed (never stored plaintext).
    expect(hasher.hash).toHaveBeenCalledWith(PASSWORD);
  });

  it('rejects an unknown role and blocks a manager from creating a non-staff role', async () => {
    usersRepo.findByEmail.mockResolvedValue(null);

    roles.findByName.mockResolvedValueOnce(null);
    const bad = await useCase.execute(makeManager(), [
      {
        email: 'x@acme.test',
        firstName: 'X',
        lastName: 'Y',
        password: PASSWORD,
        role: 'NOPE' as Role,
      },
    ]);
    expect(bad.errors[0].error).toMatch(/unknown role/);

    roles.findByName.mockResolvedValueOnce({ id: 'role-manager', name: Role.MANAGER });
    const escalated = await useCase.execute(makeManager(), [
      {
        email: 'z@acme.test',
        firstName: 'Z',
        lastName: 'W',
        password: PASSWORD,
        role: Role.MANAGER,
      },
    ]);
    expect(escalated.errors[0].error).toBe('managers can only create staff');
    expect(usersRepo.create).not.toHaveBeenCalled();
  });

  it('lets a Super Admin create a Manager reporting to them in a chosen company', async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    roles.findByName.mockResolvedValueOnce({ id: 'role-manager', name: Role.MANAGER });
    usersRepo.create.mockResolvedValue(buildEntity('lead@acme.test', Role.MANAGER));

    const result = await useCase.execute(makeSuperAdmin(), [
      {
        email: 'lead@acme.test',
        firstName: 'Lead',
        lastName: 'One',
        password: PASSWORD,
        role: Role.MANAGER,
        companyId: 'co-2',
      },
    ]);

    expect(result.errors).toHaveLength(0);
    expect(shifts.companyExists).toHaveBeenCalledWith('co-2');
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: Role.MANAGER, managerId: 'sa-1', companyId: 'co-2' }),
    );
  });

  it('lets a Super Admin place staff under a chosen manager, but not under staff', async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    usersRepo.create.mockResolvedValue(buildEntity('staff@acme.test'));

    const manager = buildEntity('m@acme.test', Role.MANAGER);
    usersRepo.findById.mockResolvedValueOnce(manager);
    const ok = await useCase.execute(makeSuperAdmin(), [
      {
        email: 'staff@acme.test',
        firstName: 'S',
        lastName: 'T',
        password: PASSWORD,
        role: Role.USER,
        managerId: 'u-new',
      },
    ]);
    expect(ok.errors).toHaveLength(0);
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ managerId: manager.id }),
    );

    usersRepo.findById.mockResolvedValueOnce(buildEntity('peer@acme.test', Role.USER));
    const bad = await useCase.execute(makeSuperAdmin(), [
      {
        email: 'staff2@acme.test',
        firstName: 'S',
        lastName: 'T',
        password: PASSWORD,
        role: Role.USER,
        managerId: 'u-new',
      },
    ]);
    expect(bad.errors[0].error).toBe('staff cannot have reports');
  });

  it('refuses an unknown company for a Super Admin', async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    shifts.companyExists.mockResolvedValueOnce(false);
    const result = await useCase.execute(makeSuperAdmin(), [
      {
        email: 'c@acme.test',
        firstName: 'C',
        lastName: 'D',
        password: PASSWORD,
        role: Role.USER,
        companyId: 'nope',
      },
    ]);
    expect(result.errors[0].error).toBe('unknown company');
  });

  it('reactivates a disabled duplicate but errors on an active duplicate', async () => {
    const disabled = buildEntity('back@acme.test');
    disabled.changeStatus('DISABLED');
    usersRepo.findByEmail.mockResolvedValueOnce(disabled);
    usersRepo.save.mockResolvedValue(disabled);

    const reactivated = await useCase.execute(makeManager(), [
      {
        email: 'back@acme.test',
        firstName: 'Back',
        lastName: 'Again',
        password: PASSWORD,
        role: Role.USER,
      },
    ]);
    expect(reactivated.created).toHaveLength(1);
    // A fresh password replaces whatever the old account had.
    expect(hasher.hash).toHaveBeenCalledWith(PASSWORD);

    usersRepo.findByEmail.mockResolvedValueOnce(buildEntity('dup@acme.test'));
    const dup = await useCase.execute(makeManager(), [
      {
        email: 'dup@acme.test',
        firstName: 'Dup',
        lastName: 'User',
        password: PASSWORD,
        role: Role.USER,
      },
    ]);
    expect(dup.errors[0].error).toBe('email already exists');
  });

  it("does not let a manager reactivate another manager's disabled staff", async () => {
    const theirs = User.fromPersistence({
      ...(buildEntity('theirs@acme.test') as any).props,
      managerId: 'other-manager',
      status: 'DISABLED',
    });
    usersRepo.findByEmail.mockResolvedValueOnce(theirs);

    const result = await useCase.execute(makeManager(), [
      {
        email: 'theirs@acme.test',
        firstName: 'T',
        lastName: 'S',
        password: PASSWORD,
        role: Role.USER,
      },
    ]);
    // Same answer as an active duplicate: the account's existence is not theirs to learn.
    expect(result.errors[0].error).toBe('email already exists');
    expect(usersRepo.save).not.toHaveBeenCalled();
  });

  it('does not let a manager reactivate a disabled account from another company', async () => {
    const elsewhere = User.fromPersistence({
      ...(buildEntity('elsewhere@acme.test') as any).props,
      managerId: null,
      companyId: 'co-other',
      status: 'DISABLED',
    });
    usersRepo.findByEmail.mockResolvedValueOnce(elsewhere);

    const result = await useCase.execute(makeManager(), [
      {
        email: 'elsewhere@acme.test',
        firstName: 'E',
        lastName: 'W',
        password: PASSWORD,
        role: Role.USER,
      },
    ]);
    expect(result.errors[0].error).toBe('email already exists');
    expect(usersRepo.save).not.toHaveBeenCalled();
  });

  it("refuses another company's shift", async () => {
    usersRepo.findByEmail.mockResolvedValueOnce(null);
    shifts.findById.mockResolvedValueOnce({
      id: 's-9',
      companyId: 'co-other',
      start: '09:00',
      end: '18:00',
    });

    const result = await useCase.execute(makeManager(), [
      {
        email: 'new@acme.test',
        firstName: 'N',
        lastName: 'U',
        password: PASSWORD,
        role: Role.USER,
        shiftId: 's-9',
      },
    ]);
    expect(result.errors[0].error).toBe('that shift belongs to another company');
    expect(usersRepo.create).not.toHaveBeenCalled();
  });
});
