import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { ActivitySampleRecord } from '@modules/activity/domain/activity-sample.repository';
import { GetDashboardAnalyticsUseCase } from './get-dashboard-analytics.use-case';

/**
 * 4.0 (docs/4.0/SPEC.md 1.2): the dashboard's top apps are timeline data; its
 * keyboard and mouse figures are activity data. A Manager sees only the parts granted.
 */
const DAY = '2026-10-13';
const samples: ActivitySampleRecord[] = Array.from({ length: 40 }, (_, i) => ({
  id: `s${i}`,
  userId: 'staff',
  deviceId: null,
  date: DAY,
  at: new Date(Date.UTC(2026, 9, 13, 5, i)),
  durationSec: 60,
  idle: i % 10 === 9,
  locked: false,
  app: i < 20 ? 'Excel' : 'Chrome',
  title: 'Budget.xlsx',
  url: null,
}));

function setup() {
  const reader = {
    loadWindow: jest.fn().mockResolvedValue({
      samplesByDate: new Map([[DAY, samples]]),
      onlineByDate: new Map(),
      presenceByDate: new Map([
        [
          DAY,
          [
            {
              type: 'LUNCH',
              startedAt: new Date(Date.UTC(2026, 9, 13, 8, 0)),
              endedAt: new Date(Date.UTC(2026, 9, 13, 8, 30)),
              durationSec: 1800,
            },
          ],
        ],
      ]),
    }),
  };
  const facts = {
    find: jest.fn(async (id: string) =>
      id === 'staff' ? { id, role: 'USER', companyId: 'c1', departmentId: 'd1' } : null,
    ),
  };
  return new GetDashboardAnalyticsUseCase(reader as never, facts as never);
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

describe('GetDashboardAnalyticsUseCase (4.0 grants)', () => {
  it('both grants: top apps and every activity figure', async () => {
    const d = await setup().execute(manager(true, true), 'staff', DAY);
    expect(d.topApps.length).toBe(2);
    expect(d.kpis.active.value).toBeGreaterThan(0);
    expect(d.timeline.length).toBeGreaterThan(0);
    expect(d.kpis.lunch.value).toBe(1800);
  });

  it('timeline only: top apps, no keyboard and mouse figures; lunch and meetings stay', async () => {
    const d = await setup().execute(manager(true, false), 'staff', DAY);
    expect(d.topApps.length).toBe(2);
    expect(d.kpis.active).toEqual({ value: 0, deltaPct: null, spark: [] });
    expect(d.kpis.idle).toEqual({ value: 0, deltaPct: null, spark: [] });
    expect(d).toMatchObject({
      timeline: [],
      dailyFlow: [],
      focusSessions: [],
      weeklyScore: [],
      focusTrend: [],
    });
    expect(d.workVsBreak.workSec).toBe(0);
    expect(d.kpis.lunch.value).toBe(1800);
  });

  it('activity only: the figures, no top apps (they were returned under the activity grant before)', async () => {
    const d = await setup().execute(manager(false, true), 'staff', DAY);
    expect(d.topApps).toEqual([]);
    expect(d.kpis.active.value).toBeGreaterThan(0);
    expect(d.timeline.length).toBeGreaterThan(0);
  });

  it('neither grant: 403 GRANT_REQUIRED; someone outside the scope: 404', async () => {
    await expect(setup().execute(manager(false, false), 'staff', DAY)).rejects.toMatchObject({
      status: 403,
      code: 'GRANT_REQUIRED',
    });
    await expect(setup().execute(manager(true, true), 'nobody', DAY)).rejects.toMatchObject({
      status: 404,
    });
  });
});
