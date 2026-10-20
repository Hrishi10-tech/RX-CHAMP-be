import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { TeamOverviewService } from './team-overview.service';

/**
 * Re-audit L5: GET /team?departmentId= for a department of another organisation
 * (or, for a Manager, one that is not theirs) answers 404, as reports do, instead
 * of an empty list.
 */
const ORG = 'c1';
const user = (role: Role, depts: string[] = []) =>
  ({
    id: 'me',
    role,
    companyId: ORG,
    orgId: ORG,
    managedDepartmentIds: depts,
    grants: { screenshots: true, timeline: true, activity: true },
  }) as unknown as AuthenticatedUser;

function setup() {
  const reader = {
    departmentsOf: jest.fn().mockResolvedValue([
      { id: 'd1', name: 'Billing' },
      { id: 'd2', name: 'Coding' },
    ]),
  };
  // Past the department check the people are read: stop there.
  const scope = { scope: jest.fn().mockRejectedValue(new Error('people read')) };
  const svc = new TeamOverviewService(
    reader as never,
    {} as never,
    scope as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, reader };
}

describe('GET /team?departmentId= (re-audit L5)', () => {
  const NOW = new Date('2026-10-20T06:00:00.000Z');

  it("another organisation's department is unknown (404), for the Admin and a Manager", async () => {
    const { svc } = setup();
    for (const me of [user(Role.ADMIN), user(Role.MANAGER, ['d1'])]) {
      await expect(svc.team(me, { departmentId: 'far' }, NOW)).rejects.toMatchObject({
        status: 404,
      });
    }
  });

  it("a Manager's filter must be one of their departments", async () => {
    const { svc } = setup();
    await expect(
      svc.team(user(Role.MANAGER, ['d1']), { departmentId: 'd2' }, NOW),
    ).rejects.toMatchObject({ status: 404 });
    await expect(svc.team(user(Role.MANAGER, ['d1']), { departmentId: 'd1' }, NOW)).rejects.toThrow(
      'people read',
    );
  });

  it("the Admin filters by any of the organisation's departments; no filter, no check", async () => {
    const { svc, reader } = setup();
    await expect(svc.team(user(Role.ADMIN), { departmentId: 'd2' }, NOW)).rejects.toThrow(
      'people read',
    );
    reader.departmentsOf.mockClear();
    await expect(svc.team(user(Role.ADMIN), {}, NOW)).rejects.toThrow('people read');
    expect(reader.departmentsOf).toHaveBeenCalledTimes(1); // the cached view's own read
  });
});
