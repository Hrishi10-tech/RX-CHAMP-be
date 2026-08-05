import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ListUsersUseCase } from './list-users.use-case';

function actor(role: Role, id = 'a-1'): AuthenticatedUser {
  return {
    id,
    email: 'a@acme.test',
    role,
    permissions: [],
    department: null,
    companyId: null,
    status: 'ACTIVE',
  };
}

describe('ListUsersUseCase', () => {
  const users = { findAll: jest.fn(), count: jest.fn() } as any;
  const useCase = new ListUsersUseCase(users);

  beforeEach(() => {
    jest.resetAllMocks();
    users.findAll.mockResolvedValue([]);
    users.count.mockResolvedValue(0);
  });

  it('passes the requested sort through to the repository', async () => {
    await useCase.execute(actor(Role.ADMIN), { sort: 'name_asc' });

    expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ sort: 'name_asc' }));
  });

  it.each(['name_asc', 'name_desc', 'joined_asc', 'joined_desc', 'role_asc', 'role_desc'] as const)(
    'forwards %s unchanged',
    async (sort) => {
      await useCase.execute(actor(Role.ADMIN), { sort });

      expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ sort }));
    },
  );

  it('leaves sort undefined when the client omits it, so the repository default applies', async () => {
    await useCase.execute(actor(Role.ADMIN), {});

    expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ sort: undefined }));
  });

  it('keeps sorting alongside the role scope a manager is confined to', async () => {
    await useCase.execute(actor(Role.MANAGER, 'mgr-1'), { sort: 'role_desc' });

    expect(users.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'role_desc', managerId: 'mgr-1' }),
    );
  });

  it('paginates independently of the sort', async () => {
    await useCase.execute(actor(Role.ADMIN), { sort: 'name_asc', page: 3, limit: 10 });

    expect(users.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'name_asc', skip: 20, take: 10 }),
    );
  });
});
