import { AuthenticatedUser, NO_GRANTS } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { AppException } from '@shared/exceptions/app.exception';
import { WorkSessionRecord } from '@modules/worktime/domain/work-session.repository';
import { AgentHealthPerson } from '../domain/agent-health.reader';
import { AgentHealthService, dayOf } from './agent-health.service';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const DEPT = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-03T08:00:00Z');
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);

function actor(role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  const platform = role === Role.SUPER_ADMIN || role === Role.SUPER_MANAGER;
  return {
    id: 'me',
    email: 'me@a.test',
    role,
    permissions: [],
    department: null,
    companyId: platform ? null : ORG_A,
    orgId: platform ? null : ORG_A,
    status: 'ACTIVE',
    managedDepartmentIds: [],
    ...over,
  } as AuthenticatedUser;
}

function person(id: string, first: string, companyId: string, companyName: string) {
  return {
    id,
    firstName: first,
    lastName: 'X',
    email: `${id}@a.test`,
    role: 'USER',
    department: 'Ops',
    departmentId: DEPT,
    companyId,
    companyName,
  } satisfies AgentHealthPerson;
}

function session(userId: string, over: Partial<WorkSessionRecord> = {}): WorkSessionRecord {
  return {
    id: `s-${userId}`,
    userId,
    date: '2026-11-03',
    startedAt: min(120),
    endedAt: null,
    endReason: null,
    source: 'AGENT',
    ...over,
  };
}

describe('AgentHealthService', () => {
  const healthy = person('u-healthy', 'Asha', ORG_A, 'Acme');
  const silent = person('u-silent', 'Bala', ORG_B, 'Beta');

  const reader = {
    people: jest.fn(),
    sampleStats: jest.fn(),
    screenshotStats: jest.fn(),
    signIns: jest.fn(),
    screenshotsEnabled: jest.fn(),
  };
  const contacts = { forUsers: jest.fn(), touch: jest.fn(), recordRefusal: jest.fn() };
  const sessions = { listForUsersBetween: jest.fn() };
  const days = { dayWith: jest.fn(() => ({ dateKey: '2026-11-03' })) };
  const plans = {
    context: jest.fn(async () => ({
      shifts: {},
      plan: () => ({ isWorkingDay: true, shift: null }),
    })),
  };
  const svc = () =>
    new AgentHealthService(
      days as never,
      plans as never,
      sessions as never,
      reader as never,
      contacts as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    reader.people.mockResolvedValue([healthy, silent]);
    reader.sampleStats.mockResolvedValue(
      new Map([[healthy.id, { lastAt: min(1), lastActiveAt: min(1), today: 90, lastIdle: false }]]),
    );
    reader.screenshotStats.mockResolvedValue(
      new Map([[healthy.id, { lastAt: min(5), today: 20 }]]),
    );
    reader.signIns.mockResolvedValue(
      new Map([[healthy.id, { signedIn: true, agentUserAgent: 'RXVisionAgent/4.0.1 (Windows)' }]]),
    );
    reader.screenshotsEnabled.mockResolvedValue(new Map([[healthy.id, true]]));
    contacts.forUsers.mockResolvedValue(
      new Map([
        [
          healthy.id,
          {
            userId: healthy.id,
            lastContactAt: min(1),
            userAgent: 'RXVisionAgent/4.0.1 (Windows)',
            lastRefusal: null,
          },
        ],
      ]),
    );
    sessions.listForUsersBetween.mockResolvedValue([session(healthy.id)]);
  });

  it('builds one row per person, problems first, with the organisation on each row', async () => {
    const view = await svc().list(actor(Role.SUPER_MANAGER), {}, NOW);
    expect(view.organisationId).toBeNull();
    expect(view.rows.map((r) => r.userId)).toEqual([silent.id, healthy.id]);
    const [bad, good] = view.rows;
    expect(good).toMatchObject({
      companyId: ORG_A,
      companyName: 'Acme',
      departmentId: DEPT,
      agent: { version: '4.0.1', signedIn: true, status: 'ACTIVE', samplesToday: 90 },
      day: { state: 'OPEN', workday: true },
      screenshots: { enabled: true, today: 20 },
      flags: [],
    });
    expect(bad).toMatchObject({
      companyName: 'Beta',
      agent: { version: null, status: 'NEVER', signedIn: false },
      day: { state: 'NOT_STARTED' },
    });
    expect(bad.flags).toEqual(expect.arrayContaining(['NEVER_REPORTED', 'SIGNED_OUT']));
    expect(view.summary).toMatchObject({ people: 2, tracking: 1, notStarted: 1 });
  });

  it('problemsOnly leaves the healthy out but keeps the summary whole', async () => {
    const view = await svc().list(actor(Role.ADMIN), { problemsOnly: true }, NOW);
    expect(view.organisationId).toBe(ORG_A);
    expect(view.rows.map((r) => r.userId)).toEqual([silent.id]);
    expect(view.summary.people).toBe(2);
  });

  it('reads only the people in scope, with one query per table', async () => {
    const me = actor(Role.MANAGER, {
      managedDepartmentIds: [DEPT],
      grants: { ...NO_GRANTS, screenshots: true },
    });
    await svc().list(me, { departmentId: DEPT }, NOW);
    const where = reader.people.mock.calls[0][0] as { AND: unknown[] };
    expect(JSON.stringify(where)).toContain(DEPT);
    expect(JSON.stringify(where)).toContain(ORG_A);
    expect(reader.sampleStats).toHaveBeenCalledWith([healthy.id, silent.id], expect.any(String));
    expect(plans.context).toHaveBeenCalledTimes(1);
  });

  it('refuses a Manager without view grants before reading anything', async () => {
    const me = actor(Role.MANAGER, { managedDepartmentIds: [DEPT], grants: NO_GRANTS });
    await expect(svc().list(me, {}, NOW)).rejects.toMatchObject({ code: 'GRANT_REQUIRED' });
    expect(reader.people).not.toHaveBeenCalled();
  });

  it('refuses Staff', async () => {
    await expect(svc().list(actor(Role.USER), {}, NOW)).rejects.toBeInstanceOf(AppException);
  });

  it('flags No Start Day from the calendar and the shift start', async () => {
    plans.context.mockResolvedValueOnce({
      shifts: {},
      plan: () => ({
        isWorkingDay: true,
        shift: { start: '00:01', end: '23:59' },
      }),
    } as never);
    sessions.listForUsersBetween.mockResolvedValueOnce([]);
    // The healthy person's agent is calling but the day was never started; the
    // shift (00:01 in the business timezone) started hours before NOW.
    const view = await svc().list(actor(Role.ADMIN), {}, NOW);
    const row = view.rows.find((r) => r.userId === healthy.id)!;
    expect(row.day.shiftStart).not.toBeNull();
    expect(row.flags).toContain('DAY_NOT_STARTED');
  });
});

describe('dayOf', () => {
  it('reads OPEN from an open session (a night shift dated yesterday too)', () => {
    const d = dayOf(
      [
        session('u', { id: 'a', date: '2026-11-02', startedAt: min(600), endedAt: min(500) }),
        session('u', { id: 'b', date: '2026-11-02', startedAt: min(400), endedAt: null }),
      ],
      '2026-11-03',
    );
    expect(d).toEqual({ state: 'OPEN', startedAt: min(600), endedAt: null });
  });

  it('reads ENDED from today’s closed sessions and NOT_STARTED otherwise', () => {
    expect(dayOf([session('u', { startedAt: min(300), endedAt: min(10) })], '2026-11-03')).toEqual({
      state: 'ENDED',
      startedAt: min(300),
      endedAt: min(10),
    });
    expect(
      dayOf([session('u', { date: '2026-11-02', endedAt: min(900) })], '2026-11-03').state,
    ).toBe('NOT_STARTED');
  });
});
