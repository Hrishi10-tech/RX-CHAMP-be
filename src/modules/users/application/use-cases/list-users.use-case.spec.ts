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

  // The filter panel offers Role, Team, Company and a joined-date range. They are
  // independent controls, so every combination has to reach the repository — the
  // list is then narrowed by all of them at once.
  describe('filters', () => {
    it('combines role and team, which is what the panel asks for', async () => {
      await useCase.execute(actor(Role.ADMIN), { role: Role.USER, department: 'Marketing' });

      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ role: Role.USER, department: 'Marketing' }),
      );
    });

    it('keeps the role filter when a managerId is also given', async () => {
      // Regression: the two used to be either/or, so picking a Role on any
      // manager-scoped screen silently did nothing.
      await useCase.execute(actor(Role.ADMIN), { managerId: 'mgr-9', role: Role.MANAGER });

      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ managerId: 'mgr-9', role: Role.MANAGER }),
      );
    });

    it('forwards the company filter', async () => {
      await useCase.execute(actor(Role.ADMIN), { companyId: 'co-1' });

      expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'co-1' }));
    });

    it('widens the joined range to whole days at both ends', async () => {
      await useCase.execute(actor(Role.ADMIN), {
        joinedFrom: '2026-08-01',
        joinedTo: '2026-08-31',
      });

      const filter = users.findAll.mock.calls[0][0];
      // Someone who joined at 09:00 on the 1st, or 23:00 on the 31st, must match.
      expect(filter.joinedFrom.getHours()).toBe(0);
      expect(filter.joinedFrom.getMinutes()).toBe(0);
      expect(filter.joinedTo.getHours()).toBe(23);
      expect(filter.joinedTo.getMinutes()).toBe(59);
      expect(filter.joinedTo.getSeconds()).toBe(59);
    });

    it('leaves the joined range undefined when no dates are picked', async () => {
      await useCase.execute(actor(Role.ADMIN), { role: Role.USER });

      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ joinedFrom: undefined, joinedTo: undefined }),
      );
    });

    it('applies every filter at once', async () => {
      await useCase.execute(actor(Role.ADMIN), {
        role: Role.USER,
        department: 'Marketing',
        companyId: 'co-1',
        joinedFrom: '2026-08-01',
        joinedTo: '2026-08-31',
        search: 'gowtham',
      });

      const filter = users.findAll.mock.calls[0][0];
      expect(filter).toMatchObject({
        role: Role.USER,
        department: 'Marketing',
        companyId: 'co-1',
        search: 'gowtham',
      });
      expect(filter.joinedFrom).toBeInstanceOf(Date);
      expect(filter.joinedTo).toBeInstanceOf(Date);
    });

    it("never lets a manager's filters reach outside their own team", async () => {
      await useCase.execute(actor(Role.MANAGER, 'mgr-1'), {
        managerId: 'someone-else',
        department: 'Marketing',
      });

      // Their own scope wins over the managerId they asked for; the team filter
      // still applies within it.
      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ managerId: 'mgr-1', department: 'Marketing' }),
      );
    });

    it('counts with the same filters it lists with, so paging totals match', async () => {
      await useCase.execute(actor(Role.ADMIN), {
        role: Role.USER,
        department: 'Marketing',
        page: 2,
        limit: 5,
      });

      const listed = users.findAll.mock.calls[0][0];
      const counted = users.count.mock.calls[0][0];
      expect(counted).toMatchObject({ role: Role.USER, department: 'Marketing' });
      // The count must not be narrowed by the page window.
      expect(counted.skip).toBeUndefined();
      expect(counted.take).toBeUndefined();
      expect(listed).toMatchObject({ skip: 5, take: 5 });
    });
  });
});
