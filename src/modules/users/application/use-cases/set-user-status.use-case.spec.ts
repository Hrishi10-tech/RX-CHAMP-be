import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { SetUserStatusUseCase } from './set-user-status.use-case';
import { User } from '../../domain/entities/user.entity';
import { Email } from '../../domain/value-objects/email.vo';
import { UserId } from '../../domain/value-objects/user-id.vo';
import { UserStatus } from '@shared/types/user.types';

function makeUser(
  over: { id?: string; role?: Role; managerId?: string | null; status?: UserStatus } = {},
): User {
  return User.fromPersistence({
    id: UserId.create(over.id ?? 'u-1'),
    email: Email.create('jane@acme.test'),
    passwordHash: 'hash',
    firstName: 'Jane',
    lastName: 'Doe',
    designation: null,
    role: over.role ?? Role.USER,
    department: 'Eng',
    managerId: over.managerId === undefined ? 'mgr-1' : over.managerId,
    companyId: null,
    companyName: null,
    shiftId: null,
    shiftStart: '10:00',
    shiftEnd: '19:00',
    status: over.status ?? 'ACTIVE',
    screenshotsEnabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  });
}

function actor(role: Role, id = 'mgr-1'): AuthenticatedUser {
  return {
    id,
    email: 'm@acme.test',
    role,
    permissions: [],
    department: 'Eng',
    companyId: null,
    status: 'ACTIVE',
  };
}

describe('SetUserStatusUseCase', () => {
  const users = { findById: jest.fn(), save: jest.fn(), count: jest.fn() } as any;
  const cache = { del: jest.fn(), get: jest.fn(), set: jest.fn(), delByPattern: jest.fn() } as any;
  const useCase = new SetUserStatusUseCase(users, cache);

  beforeEach(() => {
    jest.resetAllMocks();
    users.save.mockImplementation(async (u: User) => u);
    users.count.mockResolvedValue(5);
  });

  it("blocks a manager's own report", async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'u-1', managerId: 'mgr-1' }));

    const result = await useCase.execute(actor(Role.MANAGER), 'u-1', 'DISABLED');

    expect(result.status).toBe('DISABLED');
    expect(cache.del).toHaveBeenCalledWith('user:profile:u-1');
  });

  it('unblocks by setting ACTIVE', async () => {
    users.findById.mockResolvedValue(
      makeUser({ id: 'u-1', managerId: 'mgr-1', status: 'DISABLED' }),
    );

    const result = await useCase.execute(actor(Role.MANAGER), 'u-1', 'ACTIVE');

    expect(result.status).toBe('ACTIVE');
  });

  it('is idempotent — re-blocking an already blocked user succeeds', async () => {
    users.findById.mockResolvedValue(
      makeUser({ id: 'u-1', managerId: 'mgr-1', status: 'DISABLED' }),
    );

    const result = await useCase.execute(actor(Role.MANAGER), 'u-1', 'DISABLED');

    expect(result.status).toBe('DISABLED');
  });

  it('rejects a plain user outright', async () => {
    await expect(useCase.execute(actor(Role.USER, 'u-9'), 'u-1', 'DISABLED')).rejects.toThrow(
      /not allowed/i,
    );
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('rejects blocking yourself', async () => {
    await expect(useCase.execute(actor(Role.ADMIN, 'a-1'), 'a-1', 'DISABLED')).rejects.toThrow(
      /your own account/i,
    );
  });

  it('hides users outside the manager\'s team behind "unknown"', async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'u-2', managerId: 'other-mgr' }));

    await expect(useCase.execute(actor(Role.MANAGER), 'u-2', 'DISABLED')).rejects.toThrow(
      /unknown user/i,
    );
  });

  it('refuses to block the last active admin', async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'a-2', role: Role.ADMIN }));
    // 0 SUPER_ADMIN + 1 ADMIN active — and that one ADMIN is the target.
    users.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(
      useCase.execute(actor(Role.SUPER_ADMIN, 'sa-1'), 'a-2', 'DISABLED'),
    ).rejects.toThrow(/last active admin/i);
    expect(users.save).not.toHaveBeenCalled();
  });

  it('allows blocking an admin while others remain active', async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'a-2', role: Role.ADMIN }));
    users.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    const result = await useCase.execute(actor(Role.SUPER_ADMIN, 'sa-1'), 'a-2', 'DISABLED');

    expect(result.status).toBe('DISABLED');
  });

  it('does not run the last-admin check when unblocking', async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'a-2', role: Role.ADMIN, status: 'DISABLED' }));

    await useCase.execute(actor(Role.SUPER_ADMIN, 'sa-1'), 'a-2', 'ACTIVE');

    expect(users.count).not.toHaveBeenCalled();
  });
});
