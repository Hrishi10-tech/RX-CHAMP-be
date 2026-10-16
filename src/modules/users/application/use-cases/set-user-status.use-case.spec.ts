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
    agentActivatedAt: null,
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
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const useCase = new SetUserStatusUseCase(users, cache, events);

  beforeEach(() => {
    jest.resetAllMocks();
    users.save.mockImplementation(async (u: User) => u);
    users.count.mockResolvedValue(5);
    events.publish.mockResolvedValue(undefined);
  });

  it("blocks a manager's own report", async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'u-1', managerId: 'mgr-1' }));

    const result = await useCase.execute(actor(Role.MANAGER), 'u-1', 'DISABLED');

    expect(result.status).toBe('DISABLED');
    expect(cache.del).toHaveBeenCalledWith('user:profile:u-1');
    // Approvals waiting on (or for) this person get re-routed.
    expect(events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ userId: 'u-1', changes: ['STATUS'] }),
    );
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
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('rejects a plain user outright', async () => {
    await expect(useCase.execute(actor(Role.USER, 'u-9'), 'u-1', 'DISABLED')).rejects.toThrow(
      /not allowed/i,
    );
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('rejects blocking yourself', async () => {
    await expect(
      useCase.execute(actor(Role.SUPER_ADMIN, 'a-1'), 'a-1', 'DISABLED'),
    ).rejects.toThrow(/your own account/i);
  });

  it("does not let a manager block another manager's staff or a fellow manager", async () => {
    users.findById.mockResolvedValue(
      makeUser({ id: 'm-2', role: Role.MANAGER, managerId: 'mgr-1' }),
    );

    // Even reporting to them, a Manager is not theirs to block: only staff are.
    await expect(useCase.execute(actor(Role.MANAGER), 'm-2', 'DISABLED')).rejects.toThrow(
      /unknown user/i,
    );
  });

  it('hides users outside the manager\'s team behind "unknown"', async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'u-2', managerId: 'other-mgr' }));

    await expect(useCase.execute(actor(Role.MANAGER), 'u-2', 'DISABLED')).rejects.toThrow(
      /unknown user/i,
    );
  });

  it('refuses to block the last active Super Admin', async () => {
    users.findById.mockResolvedValue(
      makeUser({ id: 'sa-2', role: Role.SUPER_ADMIN, managerId: null }),
    );
    users.count.mockResolvedValueOnce(1);

    await expect(
      useCase.execute(actor(Role.SUPER_ADMIN, 'sa-1'), 'sa-2', 'DISABLED'),
    ).rejects.toThrow(/last active super admin/i);
    expect(users.save).not.toHaveBeenCalled();
  });

  it('allows blocking a Super Admin while another remains active', async () => {
    users.findById.mockResolvedValue(
      makeUser({ id: 'sa-2', role: Role.SUPER_ADMIN, managerId: null }),
    );
    users.count.mockResolvedValueOnce(2);

    const result = await useCase.execute(actor(Role.SUPER_ADMIN, 'sa-1'), 'sa-2', 'DISABLED');

    expect(result.status).toBe('DISABLED');
  });

  it('lets a Super Admin block a Manager without the last-admin check', async () => {
    users.findById.mockResolvedValue(makeUser({ id: 'm-2', role: Role.MANAGER, managerId: null }));

    const result = await useCase.execute(actor(Role.SUPER_ADMIN, 'sa-1'), 'm-2', 'DISABLED');

    expect(result.status).toBe('DISABLED');
    expect(users.count).not.toHaveBeenCalled();
  });

  it('does not run the last-admin check when unblocking', async () => {
    users.findById.mockResolvedValue(
      makeUser({ id: 'sa-2', role: Role.SUPER_ADMIN, managerId: null, status: 'DISABLED' }),
    );

    await useCase.execute(actor(Role.SUPER_ADMIN, 'sa-1'), 'sa-2', 'ACTIVE');

    expect(users.count).not.toHaveBeenCalled();
  });
});
