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
    createdAt: new Date(),
  });
}

describe('CreateUsersUseCase', () => {
  const usersRepo = {
    findByEmail: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  } as any;
  const shifts = { findById: jest.fn() } as any;
  const roles = { findByName: jest.fn().mockResolvedValue({ id: 'role-user', name: Role.USER }) } as any;
  const hasher = { hash: jest.fn().mockResolvedValue('hashed'), compare: jest.fn() } as any;
  const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as any;

  let useCase: CreateUsersUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    roles.findByName.mockResolvedValue({ id: 'role-user', name: Role.USER });
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

  it('resolves the role by name, forces creator as manager + inherits company, emits event', async () => {
    usersRepo.findByEmail.mockResolvedValue(null);
    usersRepo.create.mockResolvedValue(buildEntity('jane@acme.test'));

    const result = await useCase.execute(makeManager(), [
      {
        email: 'jane@acme.test',
        firstName: 'Jane',
        lastName: 'Doe',
        password: 'S3cure!',
        role: Role.USER,
        companyId: 'co-ignored',
      },
    ]);

    // Role resolved by name; managerId = creator; companyId inherited from the manager.
    expect(roles.findByName).toHaveBeenCalledWith(Role.USER);
    expect(usersRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ role: Role.USER, managerId: 'm-1', companyId: 'co-mgr' }),
    );
    expect(result.created).toHaveLength(1);
    expect(events.publish).toHaveBeenCalledTimes(1);
    // The provided password is hashed (never stored plaintext).
    expect(hasher.hash).toHaveBeenCalledWith('S3cure!');
  });

  it('rejects an unknown role and blocks a manager from creating a non-USER role', async () => {
    usersRepo.findByEmail.mockResolvedValue(null);

    roles.findByName.mockResolvedValueOnce(null);
    const bad = await useCase.execute(makeManager(), [
      { email: 'x@acme.test', firstName: 'X', lastName: 'Y', password: 'p', role: 'NOPE' as Role },
    ]);
    expect(bad.errors[0].error).toMatch(/unknown role/);

    roles.findByName.mockResolvedValueOnce({ id: 'role-admin', name: Role.ADMIN });
    const escalated = await useCase.execute(makeManager(), [
      { email: 'z@acme.test', firstName: 'Z', lastName: 'W', password: 'p', role: Role.ADMIN },
    ]);
    expect(escalated.errors[0].error).toBe('managers can only create members');
    expect(usersRepo.create).not.toHaveBeenCalled();
  });

  it('reactivates a disabled duplicate but errors on an active duplicate', async () => {
    const disabled = buildEntity('back@acme.test');
    disabled.changeStatus('DISABLED');
    usersRepo.findByEmail.mockResolvedValueOnce(disabled);
    usersRepo.save.mockResolvedValue(disabled);

    const reactivated = await useCase.execute(makeManager(), [
      { email: 'back@acme.test', firstName: 'Back', lastName: 'Again', password: 'S3cure!', role: Role.USER },
    ]);
    expect(reactivated.created).toHaveLength(1);

    usersRepo.findByEmail.mockResolvedValueOnce(buildEntity('dup@acme.test'));
    const dup = await useCase.execute(makeManager(), [
      { email: 'dup@acme.test', firstName: 'Dup', lastName: 'User', password: 'S3cure!', role: Role.USER },
    ]);
    expect(dup.errors[0].error).toBe('email already exists');
  });
});
