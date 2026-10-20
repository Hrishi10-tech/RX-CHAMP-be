import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { DEFAULT_SETTINGS } from '@modules/settings/domain/settings.rules';
import { ReportsService } from './reports.service';

/**
 * Re-audit L4: a person's day report shows the presence timeline (work and break
 * spans) only with the timeline grant, like /presence/team/:id/timeline; its
 * attendance totals, breaks and meetings stay for every reader.
 */
process.env.APP_TIMEZONE = 'Asia/Kolkata';
const NOW = new Date('2026-10-14T12:00:00.000Z');
const ORG = 'c1';

const staff = {
  id: 'a',
  firstName: 'A',
  lastName: 'Test',
  email: 'a@example.test',
  role: 'USER',
  department: 'Billing',
  departmentId: 'd1',
  managerId: null,
  companyId: ORG,
  active: true,
  joinedOn: '2026-01-01',
};

function user(role: Role, grants?: { screenshots: boolean; timeline: boolean; activity: boolean }) {
  return {
    id: 'm1',
    role,
    companyId: ORG,
    orgId: ORG,
    managedDepartmentIds: ['d1'],
    grants,
  } as unknown as AuthenticatedUser;
}

function setup() {
  const day = {
    userId: 'a',
    date: '2026-10-14',
    sessions: [
      {
        id: 's1',
        userId: 'a',
        date: '2026-10-14',
        startedAt: new Date('2026-10-14T04:00:00.000Z'),
        endedAt: new Date('2026-10-14T10:00:00.000Z'),
        endReason: 'USER',
        source: 'AGENT',
      },
    ],
    presence: [],
    breakRecords: [],
    meetingRecords: [],
    away: [],
  };
  const dayData = {
    load: jest.fn().mockResolvedValue({ day: () => day }),
    hourlyFor: jest.fn().mockResolvedValue([]),
  };
  const plans = {
    context: jest.fn().mockResolvedValue({
      settingsOf: () => DEFAULT_SETTINGS,
      plan: () => ({
        shift: null,
        isWorkingDay: true,
        label: null,
        targetSec: 8 * 3600,
        bufferMin: 10,
      }),
    }),
  };
  const scope = { person: jest.fn().mockResolvedValue(staff) };
  const approvalsReader = { pendingByUserDate: jest.fn().mockResolvedValue([]) };
  const approvals = { itemsFor: jest.fn().mockResolvedValue([]) };
  const meetings = { names: jest.fn().mockResolvedValue(new Map()) };
  const svc = new ReportsService(
    {} as never,
    {} as never,
    approvalsReader as never,
    scope as never,
    dayData as never,
    approvals as never,
    meetings as never,
    {} as never,
    {} as never,
    plans as never,
    {} as never,
  );
  return { svc };
}

describe('GET /reports/person/:id/day timeline (re-audit L4)', () => {
  it('the Admin and a Manager with the timeline grant get the work and break spans', async () => {
    const { svc } = setup();
    const admin = await svc.personDay(user(Role.ADMIN), 'a', '2026-10-14', NOW);
    expect(admin.timeline.length).toBeGreaterThan(0);
    const granted = await svc.personDay(
      user(Role.MANAGER, { screenshots: false, timeline: true, activity: false }),
      'a',
      '2026-10-14',
      NOW,
    );
    expect(granted.timeline).toEqual(admin.timeline);
  });

  it('a Manager without it gets none; the totals, breaks and meetings stay', async () => {
    const { svc } = setup();
    const admin = await svc.personDay(user(Role.ADMIN), 'a', '2026-10-14', NOW);
    const r = await svc.personDay(
      user(Role.MANAGER, { screenshots: true, timeline: false, activity: true }),
      'a',
      '2026-10-14',
      NOW,
    );
    expect(r.timeline).toEqual([]);
    expect(r.summary.focusSec).toBe(admin.summary.focusSec);
    expect(r.summary.focusSec).toBeGreaterThan(0);
    expect(r.breaks).toEqual([]);
    expect(r.meetings).toEqual([]);
  });
});
