import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { PersonRow } from '../domain/worktime.reader';
import { TeamTodayService } from './team-today.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

// 01:30 on 14 Oct in India: the day person's 14th, the night shift's 13th.
const NOW = new Date('2026-10-13T20:00:00Z');

const person = (id: string, name: string): PersonRow => ({
  id,
  firstName: name,
  lastName: 'Test',
  email: `${id}@x.test`,
  role: 'USER',
  department: 'Billing',
  designation: null,
  companyId: 'c1',
  managerId: 'm1',
  managerName: 'Maya',
  active: true,
  joinedOn: '2026-01-01',
});

function setup() {
  const day = (userId: string, date: string) => ({
    userId,
    date,
    sessions:
      userId === 'night'
        ? [
            {
              id: 's1',
              userId,
              date,
              startedAt: new Date('2026-10-13T13:00:00Z'),
              endedAt: null,
              endReason: null,
              source: 'AGENT',
            },
          ]
        : [],
    presence: [],
    breakRecords: [],
    meetingRecords: [],
  });
  const approvals = {
    pendingByUserDate: jest.fn().mockResolvedValue([
      { userId: 'night', date: '2026-10-13', pending: 2 },
      { userId: 'night', date: '2026-10-14', pending: 5 },
    ]),
    count: jest.fn().mockResolvedValue(0),
  };
  const reader = { presenceOverlapping: jest.fn().mockResolvedValue([]) };
  const sessions = {
    listOverlapping: jest.fn().mockResolvedValue([
      {
        id: 's1',
        userId: 'night',
        date: '2026-10-13',
        startedAt: new Date('2026-10-13T13:00:00Z'),
        endedAt: null,
      },
    ]),
  };
  const scope = {
    scope: jest.fn().mockResolvedValue([person('day', 'Asha'), person('night', 'Nisha')]),
  };
  const dayData = {
    load: jest.fn().mockResolvedValue({ day }),
    bucketHours: jest.fn().mockResolvedValue(new Map()),
    bucketHourly: jest.fn().mockReturnValue([]),
  };
  const days = {
    context: jest.fn().mockResolvedValue({}),
    dayWith: jest.fn().mockReturnValue({ dateKey: '2026-10-14' }),
    resolveWith: jest.fn().mockReturnValue({ shift: null }),
    forDate: jest.fn().mockReturnValue({ slots: [] }),
  };
  const settings = {
    get: jest.fn().mockResolvedValue({ quietHourActiveMin: 20, lateStartGraceMin: 10 }),
  };
  const svc = new TeamTodayService(
    approvals as never,
    reader as never,
    sessions as never,
    scope as never,
    dayData as never,
    days as never,
    settings as never,
  );
  return { svc, dayData, scope, sessions };
}

const me = { id: 'm1', role: Role.MANAGER } as unknown as AuthenticatedUser;

describe('Team today', () => {
  it("live: each person's own working day (a night shift past midnight is still the evening's)", async () => {
    const { svc, dayData, scope } = setup();
    const view = await svc.today(me, {}, NOW);
    expect(scope.scope.mock.calls[0][1]).toMatchObject({
      fromDate: '2026-10-13',
      toDate: '2026-10-14',
    });
    expect(dayData.load.mock.calls[0].slice(1, 3)).toEqual(['2026-10-13', '2026-10-14']);
    const byId = Object.fromEntries(view.rows.map((r) => [r.user.id, r]));
    expect(byId.day).toMatchObject({ date: '2026-10-14', status: 'NOT_STARTED', pending: 0 });
    expect(byId.night).toMatchObject({ date: '2026-10-13', status: 'WORKING', pending: 2 });
    expect(view.date).toBe('2026-10-14');
  });

  it('an asked day is that day for everyone', async () => {
    const { svc, sessions } = setup();
    const view = await svc.today(me, { date: '2026-10-12' }, NOW);
    expect(sessions.listOverlapping).not.toHaveBeenCalled();
    expect(view.rows.every((r) => r.date === '2026-10-12')).toBe(true);
  });
});
