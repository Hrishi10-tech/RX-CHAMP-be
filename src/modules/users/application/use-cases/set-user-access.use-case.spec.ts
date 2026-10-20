// POST /users/:id/grants and /users/:id/idle, and the people endpoints that
// moved to Admin-only in 4.0 (password, screenshots, delete).
import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import {
  DEPT_A1,
  IDS,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { cast, fakeUsers } from '../../testing/people.testing-spec';
import { DeleteUserUseCase } from './delete-user.use-case';
import { SetUserGrantsUseCase } from './set-user-grants.use-case';
import { SetUserIdleUseCase } from './set-user-idle.use-case';
import { SetUserPasswordUseCase } from './set-user-password.use-case';
import { SetUserScreenshotsUseCase } from './set-user-screenshots.use-case';

function deps() {
  const people = cast();
  const users = fakeUsers(Object.values(people));
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const audit = { record: jest.fn() };
  const cache = { del: jest.fn() };
  const hasher = { hash: jest.fn(async () => 'hashed'), compare: jest.fn() };
  return { people, users, events, audit, cache, hasher };
}

const ALL = { screenshots: true, timeline: true, activity: true };

describe('SetUserGrantsUseCase', () => {
  it("sets a Manager's grants, refreshes their sockets and audits it", async () => {
    const d = deps();
    const useCase = new SetUserGrantsUseCase(d.users as any, d.events as any, d.audit as any);
    await expect(useCase.execute(admin(ORG_A), IDS.managerA1, ALL)).resolves.toMatchObject({
      grants: ALL,
    });
    expect(d.events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ userId: IDS.managerA1, changes: ['ROLE'] }),
    );
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'USER_GRANTS_CHANGED', entityId: IDS.managerA1 }),
    );
  });

  it('is quiet when nothing changes', async () => {
    const d = deps();
    const useCase = new SetUserGrantsUseCase(d.users as any, d.events as any, d.audit as any);
    await useCase.execute(admin(ORG_A), IDS.managerA1, {
      screenshots: false,
      timeline: false,
      activity: false,
    });
    expect(d.users.save).not.toHaveBeenCalled();
    expect(d.events.publish).not.toHaveBeenCalled();
  });

  it('applies to Managers only (400 NOT_A_MANAGER)', async () => {
    const d = deps();
    const useCase = new SetUserGrantsUseCase(d.users as any, d.events as any, d.audit as any);
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1, ALL)).rejects.toMatchObject({
      code: 'NOT_A_MANAGER',
    });
  });

  it.each([
    ['another organisation (Admin)', admin(ORG_B), 404],
    ['another organisation (Super Admin)', superAdmin(ORG_B), 404],
    ['a Manager (themselves)', manager([DEPT_A1]), 403],
    ['Staff', staff(), 404],
  ] as const)('is refused for %s', async (_who, me, status) => {
    const d = deps();
    const useCase = new SetUserGrantsUseCase(d.users as any, d.events as any, d.audit as any);
    await expect(useCase.execute(me, IDS.managerA1, ALL)).rejects.toMatchObject({ status });
  });
});

describe('SetUserIdleUseCase', () => {
  it('sets and clears the override, telling agents (IDLE)', async () => {
    const d = deps();
    const useCase = new SetUserIdleUseCase(d.users as any, d.events as any);
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1, true, 7)).resolves.toMatchObject({
      idle: { enabled: true, minutes: 7 },
    });
    const [name, event] = d.events.publish.mock.calls[0];
    expect(name).toBe(OrgConfigChangedEvent.eventName);
    expect(event).toMatchObject({ companyId: ORG_A, kind: 'IDLE' });
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1, null, null)).resolves.toMatchObject({
      idle: { enabled: null, minutes: null },
    });
  });

  it.each([1, 61, 2.5])('refuses %p minutes', async (minutes) => {
    const d = deps();
    const useCase = new SetUserIdleUseCase(d.users as any, d.events as any);
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1, true, minutes)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('Managers cannot, and another organisation is 404', async () => {
    const d = deps();
    const useCase = new SetUserIdleUseCase(d.users as any, d.events as any);
    await expect(useCase.execute(manager([DEPT_A1]), IDS.staffA1, true, 5)).rejects.toMatchObject({
      status: 403,
    });
    await expect(useCase.execute(admin(ORG_B), IDS.staffA1, true, 5)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('credentials and removal are Admin-only (4.0)', () => {
  it('password: Admin sets it for their Staff; sign out everywhere also invalidates installer tokens', async () => {
    const d = deps();
    const useCase = new SetUserPasswordUseCase(
      d.users as any,
      d.hasher,
      d.events as any,
      d.audit as any,
    );
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1, 'NewPass!123', true)).resolves.toEqual({
      updated: true,
      id: IDS.staffA1,
      signedOut: true,
    });
    expect(d.users.bumpEnrollVersion).toHaveBeenCalledWith(IDS.staffA1);
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'USER_PASSWORD_SET' }),
    );
    await useCase.execute(admin(ORG_A), IDS.staffA2, 'NewPass!123', false);
    expect(d.users.bumpEnrollVersion).toHaveBeenCalledTimes(1);
  });

  it("password: a Manager can no longer set their Staff's (403), nor anyone else's (404)", async () => {
    const d = deps();
    const useCase = new SetUserPasswordUseCase(
      d.users as any,
      d.hasher,
      d.events as any,
      d.audit as any,
    );
    await expect(
      useCase.execute(manager([DEPT_A1]), IDS.staffA1, 'NewPass!123'),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      useCase.execute(manager([DEPT_A1]), IDS.adminA, 'NewPass!123'),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("password: a Super Admin may reset the organisation's Admin, an Admin may not reset a Super Admin", async () => {
    const d = deps();
    const useCase = new SetUserPasswordUseCase(
      d.users as any,
      d.hasher,
      d.events as any,
      d.audit as any,
    );
    await expect(
      useCase.execute(superAdmin(ORG_A), IDS.adminA, 'NewPass!123'),
    ).resolves.toMatchObject({
      updated: true,
    });
    await expect(
      useCase.execute(admin(ORG_A), IDS.superAdmin, 'NewPass!123'),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('screenshots: Admin only', async () => {
    const d = deps();
    const useCase = new SetUserScreenshotsUseCase(d.users as any, d.cache as any);
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1, false)).resolves.toMatchObject({
      screenshotsEnabled: false,
    });
    await expect(useCase.execute(manager([DEPT_A1]), IDS.staffA1, true)).rejects.toMatchObject({
      status: 403,
    });
    await expect(useCase.execute(admin(ORG_B), IDS.staffA1, true)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('delete: Admin only, audited', async () => {
    const d = deps();
    const useCase = new DeleteUserUseCase(
      d.users as any,
      d.cache as any,
      d.events as any,
      d.audit as any,
    );
    await expect(useCase.execute(manager([DEPT_A1]), IDS.staffA1)).rejects.toMatchObject({
      status: 403,
    });
    await expect(useCase.execute(admin(ORG_B), IDS.staffA1)).rejects.toMatchObject({ status: 404 });
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1)).resolves.toEqual({
      deleted: true,
      id: IDS.staffA1,
    });
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'USER_DELETED' }),
    );
  });
});
