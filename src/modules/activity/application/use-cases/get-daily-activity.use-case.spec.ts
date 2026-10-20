import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { ActivitySampleRecord } from '../../domain/activity-sample.repository';
import { GetDailyActivityUseCase } from './get-daily-activity.use-case';

/**
 * 4.0 (docs/4.0/SPEC.md 1.2): apps and websites are the timeline; active and idle
 * time and the hourly split are activity. A Manager sees only the parts granted.
 */
const DAY = '2026-10-13';
const sample = (min: number, over: Partial<ActivitySampleRecord> = {}): ActivitySampleRecord => ({
  id: `s${min}`,
  userId: 'staff',
  deviceId: null,
  date: DAY,
  at: new Date(Date.UTC(2026, 9, 13, 5, min)),
  durationSec: 60,
  idle: false,
  locked: false,
  app: 'Excel',
  title: 'Budget.xlsx',
  url: null,
  ...over,
});

function setup() {
  const repo = {
    listForUserByDate: jest
      .fn()
      .mockResolvedValue([
        sample(0),
        sample(1),
        sample(2, { idle: true }),
        sample(3, { app: 'Chrome', url: 'github.com' }),
      ]),
  };
  const facts = {
    find: jest.fn(async (id: string) =>
      id === 'staff'
        ? { id, role: 'USER', companyId: 'c1', departmentId: 'd1' }
        : { id, role: 'USER', companyId: 'c2', departmentId: 'dx' },
    ),
  };
  const workDays = {
    findEnd: jest.fn().mockResolvedValue(null),
    findLogin: jest.fn().mockResolvedValue(null),
  };
  const meetings = { listForUserByDate: jest.fn().mockResolvedValue([]) };
  return new GetDailyActivityUseCase(
    repo as never,
    {} as never,
    facts as never,
    workDays as never,
    meetings as never,
  );
}

const manager = (timeline: boolean, activity: boolean) =>
  ({
    id: 'm1',
    role: Role.MANAGER,
    companyId: 'c1',
    orgId: 'c1',
    managedDepartmentIds: ['d1'],
    grants: { screenshots: false, timeline, activity },
  }) as unknown as AuthenticatedUser;

describe('GetDailyActivityUseCase (4.0 grants)', () => {
  it('both grants (and an Admin): everything', async () => {
    const d = await setup().execute(manager(true, true), 'staff', DAY);
    expect(d.activeSec).toBeGreaterThan(0);
    expect(d.topApps.length).toBeGreaterThan(0);
    expect(d.hourly.some((h) => h.activeSec > 0)).toBe(true);
    const admin = {
      id: 'a1',
      role: Role.ADMIN,
      companyId: 'c1',
      orgId: 'c1',
    } as unknown as AuthenticatedUser;
    expect(await setup().execute(admin, 'staff', DAY)).toEqual(d);
  });

  it('timeline only: apps and websites, no active or idle time, no hourly split', async () => {
    const d = await setup().execute(manager(true, false), 'staff', DAY);
    expect(d.topApps.length).toBeGreaterThan(0);
    expect(d).toMatchObject({
      activeSec: 0,
      idleSec: 0,
      extraSec: 0,
      hourly: [],
      clockedOut: false,
    });
  });

  it('activity only: active and idle time and the hours, no apps or websites', async () => {
    const d = await setup().execute(manager(false, true), 'staff', DAY);
    expect(d.activeSec).toBeGreaterThan(0);
    expect(d.hourly.length).toBeGreaterThan(0);
    expect(d).toMatchObject({ topApps: [], topWebsites: [] });
  });

  it('neither: 403 GRANT_REQUIRED; outside the scope: 404', async () => {
    await expect(setup().execute(manager(false, false), 'staff', DAY)).rejects.toMatchObject({
      status: 403,
      code: 'GRANT_REQUIRED',
    });
    await expect(setup().execute(manager(true, true), 'elsewhere', DAY)).rejects.toMatchObject({
      status: 404,
    });
  });
});
