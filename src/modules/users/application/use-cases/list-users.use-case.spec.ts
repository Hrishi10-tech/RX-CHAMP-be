import { Role } from '@shared/rbac/roles.enum';
import {
  DEPT_A1,
  DEPT_A2,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { person } from '../../testing/people.testing-spec';
import { ListUsersUseCase } from './list-users.use-case';

describe('ListUsersUseCase', () => {
  const users = { findAll: jest.fn(), count: jest.fn() } as any;
  const presence = { presenceFor: jest.fn() } as any;
  const useCase = new ListUsersUseCase(users, presence);

  beforeEach(() => {
    jest.resetAllMocks();
    users.findAll.mockResolvedValue([]);
    users.count.mockResolvedValue(0);
    presence.presenceFor.mockResolvedValue(new Map());
  });

  describe('scope (docs/4.0/SPEC.md 5.3)', () => {
    it('Admin: everyone in their organisation except Super Admins', async () => {
      await useCase.execute(admin(ORG_A), {});
      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: ORG_A, excludeRoles: [Role.SUPER_ADMIN] }),
      );
    });

    it('Super Admin: the selected organisation; none selected answers 400 ORG_REQUIRED', async () => {
      await useCase.execute(superAdmin(ORG_B), {});
      expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ companyId: ORG_B }));
      await expect(useCase.execute(superAdmin(null), {})).rejects.toMatchObject({
        status: 400,
        code: 'ORG_REQUIRED',
      });
    });

    it('Manager: Staff of their departments only', async () => {
      await useCase.execute(manager([DEPT_A1, DEPT_A2]), {});
      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: ORG_A,
          roles: [Role.USER],
          departmentIds: [DEPT_A1, DEPT_A2],
        }),
      );
    });

    it('Manager with no departments sees nobody', async () => {
      await useCase.execute(manager([]), {});
      expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ departmentIds: [] }));
    });

    it('Staff: themselves', async () => {
      const me = staff();
      await useCase.execute(me, {});
      expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ ids: [me.id] }));
    });

    it("a Manager's department filter narrows their departments, never widens them", async () => {
      await useCase.execute(manager([DEPT_A1]), { departmentId: DEPT_A2 });
      expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ departmentIds: [] }));
      users.findAll.mockClear();
      await useCase.execute(manager([DEPT_A1, DEPT_A2]), {
        departmentId: DEPT_A2,
        role: Role.MANAGER,
      });
      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          departmentIds: [DEPT_A2],
          roles: [Role.USER],
          role: Role.MANAGER,
        }),
      );
    });

    it('Managers and Staff get the few fields only; Admins the full row', async () => {
      const row = person({ role: Role.USER });
      users.findAll.mockResolvedValue([row]);
      users.count.mockResolvedValue(1);

      const brief = await useCase.execute(manager([DEPT_A1]), {});
      expect(brief.users[0]).toEqual({
        id: row.id,
        name: 'Jane Doe',
        email: row.email,
        designation: null,
        department: 'Electronics',
        departmentRef: { id: DEPT_A1, name: 'Electronics', icon: 'circuit-board' },
      });
      expect(presence.presenceFor).not.toHaveBeenCalled();

      const full = await useCase.execute(admin(ORG_A), {});
      expect(full.users[0]).toMatchObject({
        id: row.id,
        role: Role.USER,
        departmentId: DEPT_A1,
        departments: [],
        grants: { screenshots: false, timeline: false, activity: false },
        idle: { enabled: null, minutes: null },
        agentStatus: 'NOT_ACTIVATED',
      });
    });
  });

  it('passes the requested sort through to the repository', async () => {
    await useCase.execute(admin(), { sort: 'name_asc' });
    expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ sort: 'name_asc' }));
  });

  it('leaves sort undefined when the client omits it, so the repository default applies', async () => {
    await useCase.execute(admin(), {});
    expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ sort: undefined }));
  });

  it('paginates independently of the sort', async () => {
    await useCase.execute(admin(), { sort: 'name_asc', page: 3, limit: 10 });
    expect(users.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'name_asc', skip: 20, take: 10 }),
    );
  });

  describe('filters', () => {
    it('combines role, department, status and q', async () => {
      await useCase.execute(admin(), {
        role: Role.USER,
        departmentId: DEPT_A1,
        status: 'DISABLED',
        q: '  gowtham ',
      });
      expect(users.findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          role: Role.USER,
          departmentIds: [DEPT_A1],
          status: 'DISABLED',
          search: 'gowtham',
          companyId: ORG_A,
        }),
      );
    });

    it('accepts the 3.x search name too', async () => {
      await useCase.execute(admin(), { search: 'ravi' });
      expect(users.findAll).toHaveBeenCalledWith(expect.objectContaining({ search: 'ravi' }));
    });

    it('widens the joined range to whole days at both ends', async () => {
      await useCase.execute(admin(), { joinedFrom: '2026-08-01', joinedTo: '2026-08-31' });
      const filter = users.findAll.mock.calls[0][0];
      expect(filter.joinedFrom.getHours()).toBe(0);
      expect(filter.joinedTo.getHours()).toBe(23);
      expect(filter.joinedTo.getMinutes()).toBe(59);
    });

    it('counts with the same filters it lists with, so paging totals match', async () => {
      await useCase.execute(admin(), {
        role: Role.USER,
        department: 'Marketing',
        page: 2,
        limit: 5,
      });
      const listed = users.findAll.mock.calls[0][0];
      const counted = users.count.mock.calls[0][0];
      expect(counted).toMatchObject({ role: Role.USER, department: 'Marketing', companyId: ORG_A });
      expect(counted.skip).toBeUndefined();
      expect(counted.take).toBeUndefined();
      expect(listed).toMatchObject({ skip: 5, take: 5 });
    });
  });
});
