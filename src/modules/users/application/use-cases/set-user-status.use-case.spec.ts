import {
  IDS,
  DEPT_A1,
  ORG_A,
  ORG_B,
  admin,
  manager,
  staff,
  superAdmin,
} from '@shared/testing/actors.testing-spec';
import { cast, fakeUsers } from '../../testing/people.testing-spec';
import { SetUserStatusUseCase } from './set-user-status.use-case';

function setup() {
  const people = cast();
  const users = fakeUsers(Object.values(people));
  const cache = { del: jest.fn(), get: jest.fn(), set: jest.fn(), delByPattern: jest.fn() } as any;
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const audit = { record: jest.fn() } as any;
  const useCase = new SetUserStatusUseCase(users as any, cache, events, audit);
  return { useCase, users, events, audit, people };
}

describe('SetUserStatusUseCase (4.0 scope)', () => {
  it('Admin blocks Staff and Managers of their organisation, audited and announced', async () => {
    const { useCase, events, audit } = setup();
    const res = await useCase.execute(admin(ORG_A), IDS.staffA1, 'DISABLED');
    expect(res.status).toBe('DISABLED');
    expect(events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ userId: IDS.staffA1, changes: ['STATUS'], active: false }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'USER_STATUS_CHANGED' }),
    );
    await expect(useCase.execute(admin(ORG_A), IDS.managerA1, 'DISABLED')).resolves.toMatchObject({
      status: 'DISABLED',
    });
  });

  it('is idempotent: re-blocking says nothing new', async () => {
    const { useCase, events } = setup();
    await useCase.execute(admin(ORG_A), IDS.staffA1, 'DISABLED');
    events.publish.mockClear();
    await useCase.execute(admin(ORG_A), IDS.staffA1, 'DISABLED');
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('another organisation answers 404, never 403', async () => {
    const { useCase } = setup();
    await expect(useCase.execute(admin(ORG_A), IDS.staffB1, 'DISABLED')).rejects.toMatchObject({
      status: 404,
    });
    await expect(useCase.execute(superAdmin(ORG_A), IDS.staffB1, 'DISABLED')).rejects.toMatchObject(
      {
        status: 404,
      },
    );
  });

  it("an Admin cannot block the organisation's Admin (themselves) or a Super Admin", async () => {
    const { useCase } = setup();
    await expect(useCase.execute(admin(ORG_A), IDS.superAdmin, 'DISABLED')).rejects.toMatchObject({
      status: 404,
    });
    await expect(useCase.execute(admin(ORG_A), IDS.adminA, 'DISABLED')).rejects.toMatchObject({
      status: 400,
    });
  });

  it("a Super Admin can block the organisation's Admin", async () => {
    const { useCase } = setup();
    await expect(useCase.execute(superAdmin(ORG_A), IDS.adminA, 'DISABLED')).resolves.toMatchObject(
      {
        status: 'DISABLED',
      },
    );
    await expect(useCase.execute(superAdmin(ORG_B), IDS.adminA, 'DISABLED')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a Super Admin without an organisation reaches nobody', async () => {
    const { useCase } = setup();
    await expect(useCase.execute(superAdmin(null), IDS.staffA1, 'DISABLED')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('Managers change nobody: 403 for their own Staff, 404 for anyone else', async () => {
    const { useCase, users } = setup();
    await expect(
      useCase.execute(manager([DEPT_A1]), IDS.staffA1, 'DISABLED'),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      useCase.execute(manager([DEPT_A1]), IDS.staffA2, 'DISABLED'),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(useCase.execute(manager([]), IDS.staffA1, 'DISABLED')).rejects.toMatchObject({
      status: 404,
    });
    expect(users.save).not.toHaveBeenCalled();
  });

  it('Staff cannot change anyone (403) and nobody changes their own status (400)', async () => {
    const { useCase } = setup();
    await expect(useCase.execute(staff(), IDS.staffA2, 'DISABLED')).rejects.toMatchObject({
      status: 403,
    });
    await expect(useCase.execute(admin(ORG_A), IDS.adminA, 'ACTIVE')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('unblocks by setting ACTIVE', async () => {
    const { useCase, events } = setup();
    await useCase.execute(admin(ORG_A), IDS.staffA1, 'DISABLED');
    events.publish.mockClear();
    await expect(useCase.execute(admin(ORG_A), IDS.staffA1, 'ACTIVE')).resolves.toMatchObject({
      status: 'ACTIVE',
    });
    expect(events.publish).toHaveBeenCalledWith(
      'user.access-changed',
      expect.objectContaining({ changes: ['STATUS'], active: true }),
    );
  });
});
