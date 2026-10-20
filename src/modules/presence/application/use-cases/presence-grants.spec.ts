import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { GetCurrentPresenceUseCase } from './get-current-presence.use-case';
import { GetProductivityUseCase } from './get-productivity.use-case';
import { GetTeamLiveUseCase } from './get-team-live.use-case';
import { GetTeamSummaryUseCase } from './get-team-summary.use-case';
import { GetUserHistoryUseCase } from './get-user-history.use-case';
import { GetUserTimelineUseCase } from './get-user-timeline.use-case';

/**
 * 4.0 (docs/4.0/SPEC.md 1.2): the 3.x presence views follow the same rule as
 * GET /team: a Manager needs at least one view grant to see anyone's day, and
 * keyboard and mouse idle time needs the activity grant.
 */
const STAFF = {
  id: 'staff',
  firstName: 'Staff',
  lastName: 'One',
  email: 'staff1@x.test',
  department: 'Billing',
};

const manager = (g: { screenshots?: boolean; timeline?: boolean; activity?: boolean }) =>
  ({
    id: 'm1',
    role: Role.MANAGER,
    companyId: 'c1',
    orgId: 'c1',
    managedDepartmentIds: ['d1'],
    grants: { screenshots: !!g.screenshots, timeline: !!g.timeline, activity: !!g.activity },
  }) as unknown as AuthenticatedUser;
const NONE = manager({});

function deps() {
  const sessions = {
    listOpenForUsers: jest.fn().mockResolvedValue([]),
    listForUsersByDate: jest.fn().mockResolvedValue([]),
    listForUserInDates: jest.fn().mockResolvedValue([]),
    listForUserByDate: jest.fn().mockResolvedValue([]),
    findOpenForUser: jest.fn().mockResolvedValue(null),
  };
  const team = { findReports: jest.fn().mockResolvedValue([STAFF]), findContext: jest.fn() };
  const dayEnds = {
    findEndsForUsers: jest.fn().mockResolvedValue(new Map()),
    findEnd: jest.fn().mockResolvedValue(null),
  };
  const workSessions = { statesFor: jest.fn().mockResolvedValue(new Map()) };
  const online = {
    sumSecondsForUsersByDate: jest.fn().mockResolvedValue(new Map()),
    sumSecondsForUserByDates: jest.fn().mockResolvedValue(new Map()),
    listIntervalsForUserByDate: jest.fn().mockResolvedValue([]),
  };
  const idle = {
    sumIdleSecondsForUserByDates: jest.fn(
      async (_u: string, dates: string[]) => new Map(dates.map((d) => [d, 900])),
    ),
    listIdleIntervalsForUserByDate: jest.fn(async (_u: string, day: string) => [
      { start: new Date(`${day}T10:00:00`), end: new Date(`${day}T10:15:00`) },
    ]),
  };
  return { sessions, team, dayEnds, workSessions, online, idle };
}

const forbidden = { status: 403, code: 'GRANT_REQUIRED' };

describe('presence views: a Manager with no grant (4.0)', () => {
  it('is refused the live board, the day summary and every per-person view', async () => {
    const d = deps();
    await expect(
      new GetTeamLiveUseCase(
        d.sessions as never,
        d.team as never,
        d.dayEnds as never,
        d.workSessions as never,
      ).execute(NONE),
    ).rejects.toMatchObject(forbidden);
    await expect(
      new GetTeamSummaryUseCase(
        d.sessions as never,
        d.team as never,
        d.online as never,
        d.dayEnds as never,
      ).execute(NONE),
    ).rejects.toMatchObject(forbidden);
    await expect(
      new GetCurrentPresenceUseCase(
        d.sessions as never,
        d.dayEnds as never,
        d.team as never,
        d.workSessions as never,
      ).forMember(NONE, 'staff'),
    ).rejects.toMatchObject(forbidden);
    await expect(
      new GetUserHistoryUseCase(
        d.sessions as never,
        d.online as never,
        d.team as never,
        d.idle as never,
      ).execute(NONE, 'staff', 2),
    ).rejects.toMatchObject(forbidden);
    await expect(
      new GetUserTimelineUseCase(
        d.sessions as never,
        d.online as never,
        d.team as never,
        d.idle as never,
      ).execute(NONE, 'staff'),
    ).rejects.toMatchObject(forbidden);
    expect(d.sessions.listOpenForUsers).not.toHaveBeenCalled();
    expect(d.idle.sumIdleSecondsForUserByDates).not.toHaveBeenCalled();
  });

  it('someone outside the scope is still unknown (404) whatever the grants', async () => {
    const d = deps();
    await expect(
      new GetCurrentPresenceUseCase(
        d.sessions as never,
        d.dayEnds as never,
        d.team as never,
        d.workSessions as never,
      ).forMember(NONE, 'other'),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('presence views: idle time needs the activity grant (4.0)', () => {
  it('history: idleSec only with the activity grant', async () => {
    const d = deps();
    const history = new GetUserHistoryUseCase(
      d.sessions as never,
      d.online as never,
      d.team as never,
      d.idle as never,
    );
    const without = await history.execute(manager({ timeline: true }), 'staff', 2);
    expect(without.days.every((x) => x.totals.idleSec === 0)).toBe(true);
    expect(d.idle.sumIdleSecondsForUserByDates).not.toHaveBeenCalled();
    const withIt = await history.execute(manager({ activity: true }), 'staff', 2);
    expect(withIt.days.every((x) => x.totals.idleSec === 900)).toBe(true);
  });

  it('timeline: needs the timeline grant; its idle seconds need the activity grant too', async () => {
    const d = deps();
    const timeline = new GetUserTimelineUseCase(
      d.sessions as never,
      d.online as never,
      d.team as never,
      d.idle as never,
    );
    await expect(
      timeline.execute(manager({ activity: true }), 'staff', '2026-10-13'),
    ).rejects.toMatchObject(forbidden);
    const only = await timeline.execute(manager({ timeline: true }), 'staff', '2026-10-13');
    expect(only.buckets.every((b) => b.idleSec === 0)).toBe(true);
    const both = await timeline.execute(
      manager({ timeline: true, activity: true }),
      'staff',
      '2026-10-13',
    );
    expect(both.buckets.reduce((s, b) => s + b.idleSec, 0)).toBe(900);
  });

  it('any one grant opens the live board and the summary', async () => {
    const d = deps();
    const live = await new GetTeamLiveUseCase(
      d.sessions as never,
      d.team as never,
      d.dayEnds as never,
      d.workSessions as never,
    ).execute(manager({ screenshots: true }));
    expect(live).toHaveLength(1);
    const summary = await new GetTeamSummaryUseCase(
      d.sessions as never,
      d.team as never,
      d.online as never,
      d.dayEnds as never,
    ).execute(manager({ screenshots: true }));
    expect(summary.rows).toHaveLength(1);
    expect(summary.rows[0].totals.idleSec).toBe(0);
  });
});

describe('GET /productivity/:id (re-audit L1)', () => {
  function productivity() {
    const d = deps();
    // Online 9:00-12:00 and 13:00-17:00 (7 h) inside a 9:00-17:00 span: 1 h idle.
    d.online.listIntervalsForUserByDate.mockResolvedValue([
      { start: new Date('2026-10-14T03:30:00Z'), end: new Date('2026-10-14T06:30:00Z') },
      { start: new Date('2026-10-14T07:30:00Z'), end: new Date('2026-10-14T11:30:00Z') },
    ]);
    Object.assign(d.online, { sumSecondsForUserByDate: jest.fn().mockResolvedValue(7 * 3600) });
    return new GetProductivityUseCase(d.sessions as never, d.online as never, d.team as never);
  }

  it('online and idle time (and the score made of them) need the activity grant', async () => {
    const withIt = await productivity().execute(manager({ activity: true }), 'staff', '2026-10-14');
    expect(withIt).toMatchObject({ onlineSec: 7 * 3600, idleSec: 3600 });
    expect(withIt.score).toBeGreaterThan(0);
    const without = await productivity().execute(
      manager({ timeline: true, screenshots: true }),
      'staff',
      '2026-10-14',
    );
    expect(without).toMatchObject({ onlineSec: 0, idleSec: 0, focusSec: 0, score: 0 });
  });

  it('people see their own in full', async () => {
    const own = await productivity().execute(
      { ...manager({}), id: 'staff', role: Role.USER } as AuthenticatedUser,
      'staff',
      '2026-10-14',
    );
    expect(own).toMatchObject({ onlineSec: 7 * 3600, idleSec: 3600 });
  });
});
