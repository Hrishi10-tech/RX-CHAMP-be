import { AppException } from '@shared/exceptions/app.exception';
import { AuthenticatedUser, NO_GRANTS } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { NoticeEvent } from '@shared/events/notice.event';
import { DayPlan } from '@modules/worktime/application/day-plan.service';
import { PersonRow } from '@modules/worktime/domain/worktime.reader';
import { emptyTotals } from '../domain/report-builder';
import {
  MonthSnapshot,
  PersonDaySummary,
  PersonMonthReport,
  TeamMonthReport,
} from '../domain/report.types';
import { MonthLockService } from './month-lock.service';
import { ReportRunsService, runSummary } from './report-runs.service';
import { reportPerson, ReportsService } from './reports.service';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

/** 4.0 callers: their organisation, a Manager's departments and grants. */
const user = (id: string, role: Role, over: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    id,
    role,
    email: `${id}@example.test`,
    permissions: [],
    companyId: role === Role.SUPER_ADMIN ? null : 'c1',
    orgId: 'c1',
    managedDepartmentIds: role === Role.MANAGER ? ['d1'] : [],
    grants: role === Role.MANAGER ? NO_GRANTS : undefined,
    ...over,
  }) as unknown as AuthenticatedUser;

function person(id: string, over: Partial<PersonRow> = {}): PersonRow {
  return {
    id,
    firstName: id.toUpperCase(),
    lastName: 'Test',
    email: `${id}@example.test`,
    role: 'USER',
    department: 'Billing',
    designation: null,
    companyId: 'c1',
    departmentId: 'd1',
    managerId: null,
    managerName: null,
    active: true,
    joinedOn: '2026-01-01',
    ...over,
  };
}

function monthOf(p: PersonRow, over: Partial<PersonMonthReport['totals']> = {}): PersonMonthReport {
  return {
    person: reportPerson(p),
    month: '2026-09',
    locked: false,
    generatedAt: '2026-10-01T00:00:00.000Z',
    totals: { ...emptyTotals(), ...over },
    days: [],
    heatmap: [],
  };
}

function built(persons: PersonMonthReport[]): {
  persons: PersonMonthReport[];
  team: TeamMonthReport;
} {
  return {
    persons,
    team: {
      month: '2026-09',
      scope: 'ALL',
      locked: false,
      generatedAt: '2026-10-01T00:00:00.000Z',
      totals: { ...emptyTotals(), people: persons.length },
      rows: [],
    },
  };
}

describe('runSummary', () => {
  it('sums the people and counts who needs a look', () => {
    const s = runSummary([
      monthOf(person('a'), {
        workdays: 20,
        full: 18,
        focusSec: 100,
        quietHours: 5,
        needsALook: true,
      }),
      monthOf(person('b'), { workdays: 21, half: 2, focusSec: 50, pending: 1 }),
    ]);
    expect(s).toMatchObject({
      people: 2,
      workdays: 41,
      full: 18,
      half: 2,
      focusSec: 150,
      pending: 1,
      needsALook: 1,
    });
  });
});

describe('ReportRunsService (per organisation, 4.0)', () => {
  // Organisation c1: its Admin, an active Manager of d1, an inactive Manager,
  // Staff in d1 and d2, and two inactive Staff of d1 (one worked in September).
  const admin = person('admin', { role: 'ADMIN', departmentId: null });
  const m1 = person('m1', { role: 'MANAGER' });
  const m2 = person('m2', { role: 'MANAGER', active: false });
  const a = person('a');
  const b = person('b', { departmentId: 'd2' });
  const c = person('c', { active: false });
  const d = person('d', { active: false });
  // Organisation c2: its Admin, a Manager of d3 and one Staff.
  const admin2 = person('admin2', { role: 'ADMIN', companyId: 'c2', departmentId: null });
  const m3 = person('m3', { role: 'MANAGER', companyId: 'c2', departmentId: 'd3' });
  const e = person('e', { companyId: 'c2', departmentId: 'd3' });
  const ORGS: Record<string, PersonRow[]> = {
    c1: [admin, m1, m2, a, b, c, d],
    c2: [admin2, m3, e],
  };

  function setup() {
    const store = {
      upsertRun: jest.fn().mockResolvedValue(undefined),
      listRuns: jest.fn().mockResolvedValue([]),
      runKeys: jest.fn().mockResolvedValue(new Set<string>()),
      // 3.1 has been running since August.
      recordFirstBoot: jest.fn().mockResolvedValue(new Date('2026-08-03T04:00:00Z')),
    };
    const reader = {
      listCompanyIds: jest.fn().mockResolvedValue(['c1', 'c2']),
      listPeople: jest.fn(async ({ companyId }: { companyId: string }) => ORGS[companyId] ?? []),
      userIdsWithSessionsBetween: jest.fn().mockResolvedValue(new Set(['c'])),
      managedDepartments: jest.fn(
        async (ids: string[]) => new Map(ids.map((id) => [id, id === 'm3' ? ['d3'] : ['d1']])),
      ),
    };
    const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    const reports = {
      buildMonth: jest.fn(async (people: PersonRow[], _month: string) =>
        built(people.map((p) => monthOf(p))),
      ),
    };
    const svc = new ReportRunsService(
      store as never,
      reader as never,
      events as never,
      reports as never,
    );
    return { svc, store, reader, events, reports };
  }

  it("builds each organisation's month once: one run per active Manager (their departments' Staff) and the Admin (everyone)", async () => {
    const { svc, store, reader, events, reports } = setup();
    const n = await svc.generate('2026-09', new Date('2026-09-30T19:00:00Z'));
    expect(n).toBe(4);
    expect(reader.listPeople).toHaveBeenCalledWith({
      companyId: 'c1',
      excludeRoles: ['SUPER_ADMIN'],
    });
    expect(reader.userIdsWithSessionsBetween).toHaveBeenCalledWith(
      ['m2', 'c', 'd'],
      '2026-09-01',
      '2026-09-30',
    );
    expect(reports.buildMonth).toHaveBeenCalledTimes(2);
    expect((reports.buildMonth.mock.calls[0][0] as PersonRow[]).map((p) => p.id)).toEqual([
      'admin',
      'm1',
      'a',
      'b',
      'c',
    ]);
    expect(store.upsertRun).toHaveBeenCalledWith(
      'c1',
      '2026-09',
      'ALL',
      'admin',
      expect.objectContaining({ people: 5 }),
    );
    // m1's departments: a and c (c is inactive but worked in September); never b of d2, never managers.
    expect(store.upsertRun).toHaveBeenCalledWith(
      'c1',
      '2026-09',
      'TEAM',
      'm1',
      expect.objectContaining({ people: 2 }),
    );
    // The other organisation is built and stored on its own.
    expect(store.upsertRun).toHaveBeenCalledWith(
      'c2',
      '2026-09',
      'ALL',
      'admin2',
      expect.objectContaining({ people: 3 }),
    );
    expect(store.upsertRun).toHaveBeenCalledWith(
      'c2',
      '2026-09',
      'TEAM',
      'm3',
      expect.objectContaining({ people: 1 }),
    );
    expect(events.publish).toHaveBeenCalledTimes(4);
    const notices = events.publish.mock.calls.map((call) => call[1] as NoticeEvent);
    expect(notices.map((x) => x.recipientIds[0])).toEqual(['admin', 'm1', 'admin2', 'm3']);
    expect(notices[0]).toMatchObject({
      type: 'MONTHLY_REPORT_READY',
      title: 'September 2026 report is ready',
    });
    expect(notices[0].body).toBe("Everyone's monthly report is ready in Reports.");
    expect(notices[1].body).toBe("Your team's monthly report is ready in Reports.");
  });

  it('one organisation failing does not stop the others', async () => {
    const { svc, store, reports } = setup();
    reports.buildMonth.mockRejectedValueOnce(new Error('db down'));
    expect(await svc.generate('2026-09', new Date('2026-09-30T19:00:00Z'))).toBe(2);
    expect(store.upsertRun.mock.calls.map((call) => call[0])).toEqual(['c2', 'c2']);
  });

  it('the job builds the previous month and never throws', async () => {
    const { svc, reports } = setup();
    // 00:30 on 1 October in India is 19:00 UTC on 30 September.
    await svc.run(new Date('2026-09-30T19:00:00Z'));
    expect(reports.buildMonth.mock.calls[0][1]).toBe('2026-09');
    reports.buildMonth.mockRejectedValue(new Error('db down'));
    await expect(svc.run(new Date('2026-09-30T19:00:00Z'))).resolves.toBeUndefined();
  });

  it('the previous month in business time, whatever the day', () => {
    expect(ReportRunsService.previousMonth(new Date('2026-10-14T06:00:00Z'))).toBe('2026-09');
    // 00:10 on 1 January in India is still 31 December in UTC.
    expect(ReportRunsService.previousMonth(new Date('2026-12-31T18:40:00Z'))).toBe('2026-12');
    expect(ReportRunsService.previousMonth(new Date('2027-01-01T06:00:00Z'))).toBe('2026-12');
  });

  it('catch-up (boot and 01:00): only the owners still missing a run, per organisation, and nothing twice', async () => {
    const { svc, store, reader, reports, events } = setup();
    reader.userIdsWithSessionsBetween.mockResolvedValue(new Set(['a']));
    store.runKeys.mockImplementation(async (companyId: string) =>
      companyId === 'c1' ? new Set(['ALL|admin']) : new Set(['ALL|admin2', 'TEAM|m3']),
    );
    await svc.catchUp(new Date('2026-10-02T06:00:00Z'));
    expect(store.runKeys).toHaveBeenCalledWith('c1', '2026-09');
    expect(store.runKeys).toHaveBeenCalledWith('c2', '2026-09');
    expect(reports.buildMonth).toHaveBeenCalledTimes(1);
    expect(store.upsertRun).toHaveBeenCalledTimes(1);
    expect(store.upsertRun).toHaveBeenCalledWith('c1', '2026-09', 'TEAM', 'm1', expect.anything());
    expect(events.publish).toHaveBeenCalledTimes(1);

    // Every owner has a run now: nothing is built or sent again.
    store.runKeys.mockImplementation(async (companyId: string) =>
      companyId === 'c1' ? new Set(['ALL|admin', 'TEAM|m1']) : new Set(['ALL|admin2', 'TEAM|m3']),
    );
    await svc.catchUp(new Date('2026-10-03T06:00:00Z'));
    expect(reports.buildMonth).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledTimes(1);
  });

  it('catch-up does nothing when nobody worked that month (a new install)', async () => {
    const { svc, reader, reports, store } = setup();
    reader.userIdsWithSessionsBetween.mockResolvedValue(new Set());
    await svc.catchUp(new Date('2026-10-02T06:00:00Z'));
    expect(reader.userIdsWithSessionsBetween).toHaveBeenCalledWith(
      null,
      '2026-09-01',
      '2026-09-30',
    );
    expect(store.runKeys).not.toHaveBeenCalled();
    expect(reports.buildMonth).not.toHaveBeenCalled();
  });

  it('catch-up never announces a month from before 3.1 first booted', async () => {
    const { svc, store, reports, events } = setup();
    // First boot on 14 October: September was built from backfilled history.
    store.recordFirstBoot.mockResolvedValue(new Date('2026-10-14T05:00:00Z'));
    await svc.catchUp(new Date('2026-10-14T06:00:00Z'));
    await svc.catchUp(new Date('2026-10-20T19:30:00Z'));
    expect(reports.buildMonth).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    // On 1 November (business time) October is 3.1's own month: caught up.
    await svc.catchUp(new Date('2026-10-31T19:30:00Z'));
    expect(reports.buildMonth.mock.calls[0][1]).toBe('2026-10');
  });

  it('a first boot exactly at the start of the month counts as this month', async () => {
    const { svc, store, reports } = setup();
    // 00:00 on 1 October in India.
    store.recordFirstBoot.mockResolvedValue(new Date('2026-09-30T18:30:00Z'));
    await svc.catchUp(new Date('2026-10-02T06:00:00Z'));
    expect(reports.buildMonth).not.toHaveBeenCalled();
  });

  it('the 00:30 job on the 1st is not affected by the first boot', async () => {
    const { svc, store, reports } = setup();
    store.recordFirstBoot.mockResolvedValue(new Date('2026-09-30T10:00:00Z'));
    await svc.run(new Date('2026-09-30T19:00:00Z'));
    expect(reports.buildMonth.mock.calls[0][1]).toBe('2026-09');
  });

  it('records the first boot once, at boot (no timer under test)', async () => {
    const { svc, store } = setup();
    svc.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(store.recordFirstBoot).toHaveBeenCalledTimes(1);
    await svc.catchUp(new Date('2026-10-02T06:00:00Z'));
    expect(store.recordFirstBoot).toHaveBeenCalledTimes(1);
    svc.onModuleDestroy();
  });

  it('one job at a time: a catch-up during the monthly run is skipped', async () => {
    const { svc, reports } = setup();
    let release: () => void = () => undefined;
    reports.buildMonth.mockImplementationOnce(
      (people: PersonRow[]) =>
        new Promise((resolve) => {
          release = () => resolve(built(people.map((p) => monthOf(p))));
        }),
    );
    const first = svc.run(new Date('2026-09-30T19:00:00Z'));
    await new Promise((r) => setImmediate(r));
    await svc.catchUp(new Date('2026-09-30T19:30:00Z'));
    release();
    await first;
    // c1 once (the skipped catch-up built nothing), then c2.
    expect(reports.buildMonth).toHaveBeenCalledTimes(2);
  });

  it("lists the caller's runs in their organisation; a Super Admin sees the organisation's everyone runs", async () => {
    const { svc, store } = setup();
    store.listRuns.mockResolvedValue([
      {
        id: 'r1',
        month: '2026-09',
        scope: 'TEAM',
        ownerId: 'm1',
        generatedAt: new Date('2026-09-30T19:00:00Z'),
        summary: { people: 2 },
      },
    ]);
    await expect(svc.list(user('m1', Role.MANAGER))).resolves.toEqual({
      items: [
        {
          id: 'r1',
          month: '2026-09',
          scope: 'TEAM',
          generatedAt: '2026-09-30T19:00:00.000Z',
          summary: { people: 2 },
        },
      ],
    });
    expect(store.listRuns).toHaveBeenLastCalledWith('c1', 'm1');
    await svc.list(user('sa', Role.SUPER_ADMIN));
    expect(store.listRuns).toHaveBeenLastCalledWith('c1', null);
    await expect(svc.list(user('sa', Role.SUPER_ADMIN, { orgId: null }))).rejects.toMatchObject({
      status: 400,
      code: 'ORG_REQUIRED',
    });
  });

  it('quiet hours and needs-a-look only for readers with the activity grant', async () => {
    const { svc, store } = setup();
    const summary = { people: 2, focusSec: 100, quietHours: 7, needsALook: 1 };
    store.listRuns.mockResolvedValue([
      {
        id: 'r1',
        month: '2026-09',
        scope: 'TEAM',
        ownerId: 'm1',
        generatedAt: new Date('2026-09-30T19:00:00Z'),
        summary,
      },
    ]);
    const without = await svc.list(
      user('m1', Role.MANAGER, { grants: { screenshots: true, timeline: true, activity: false } }),
    );
    expect(without.items[0].summary).toEqual({ people: 2, focusSec: 100 });
    const withIt = await svc.list(
      user('m1', Role.MANAGER, { grants: { screenshots: false, timeline: false, activity: true } }),
    );
    expect(withIt.items[0].summary).toEqual(summary);
    const admin = await svc.list(user('admin', Role.ADMIN));
    expect(admin.items[0].summary).toEqual(summary);
  });
});

describe('MonthLockService (per organisation, 4.0)', () => {
  function setup(
    lockResult: unknown = {
      ok: true,
      lock: { month: '2026-09', lockedById: 'admin', lockedAt: new Date('2026-10-02T05:00:00Z') },
      created: true,
    },
  ) {
    const store = {
      lockMonth: jest.fn(
        async (_c: string, _m: string, _by: string, build: () => Promise<MonthSnapshot>) => {
          await build();
          return lockResult;
        },
      ),
      findLock: jest.fn().mockResolvedValue(null),
      unlockMonth: jest.fn().mockResolvedValue(true),
    };
    const approvals = { pendingInMonth: jest.fn().mockResolvedValue(3) };
    const reader = {
      listPeople: jest
        .fn()
        .mockResolvedValue([
          person('a'),
          person('x', { active: false }),
          person('y', { active: false }),
        ]),
      userIdsWithSessionsBetween: jest.fn().mockResolvedValue(new Set(['y'])),
    };
    const people = {
      findAnyByIds: jest
        .fn()
        .mockResolvedValue([{ id: 'admin', firstName: 'Meera', lastName: 'Nair' }]),
    };
    const scope = { scope: jest.fn().mockResolvedValue([person('a'), person('b')]) };
    const reports = {
      assertMonthInRange: jest.fn().mockResolvedValue(undefined),
      monthProblem: jest.fn().mockResolvedValue(null),
      buildMonth: jest.fn(async (ps: PersonRow[]) => built(ps.map((p) => monthOf(p)))),
    };
    const svc = new MonthLockService(
      store as never,
      approvals as never,
      reader as never,
      people as never,
      scope as never,
      reports as never,
    );
    return { svc, store, approvals, scope, reports, reader };
  }
  const ADMIN = user('admin', Role.ADMIN);

  it('only the Admin, or a Super Admin acting in the organisation, locks or unlocks', async () => {
    const { svc, store } = setup();
    const mgr = user('m1', Role.MANAGER);
    await expect(svc.lock(mgr, '2026-09', new Date())).rejects.toMatchObject({ status: 403 });
    await expect(svc.unlock(mgr, '2026-09', new Date())).rejects.toMatchObject({ status: 403 });
    await expect(svc.lock(user('u', Role.USER), '2026-09', new Date())).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      svc.lock(
        user('sa', Role.SUPER_ADMIN, { orgId: null }),
        '2026-09',
        new Date('2026-10-02T05:00:00Z'),
      ),
    ).rejects.toMatchObject({ status: 400, code: 'ORG_REQUIRED' });
    expect(store.lockMonth).not.toHaveBeenCalled();
    await expect(
      svc.lock(user('sa', Role.SUPER_ADMIN), '2026-09', new Date('2026-10-02T05:00:00Z')),
    ).resolves.toMatchObject({ locked: true });
    expect(store.lockMonth).toHaveBeenCalledWith('c1', '2026-09', 'sa', expect.any(Function));
  });

  it('refuses while items are pending, with the count', async () => {
    const { svc } = setup({ ok: false, reason: 'PENDING_APPROVALS', count: 2 });
    const err = await svc
      .lock(ADMIN, '2026-09', new Date('2026-10-02T05:00:00Z'))
      .catch((x: unknown) => x);
    expect(err).toBeInstanceOf(AppException);
    expect(err).toMatchObject({ status: 409, code: 'PENDING_APPROVALS', details: { count: 2 } });
    expect((err as Error).message).toBe(
      '2 items dated in 2026-09 still wait for a decision. Decide them before locking the month.',
    );
  });

  it('refuses while a working day dated in the month is still open, with the count', async () => {
    const { svc } = setup({ ok: false, reason: 'OPEN_SESSIONS', count: 1 });
    const err = await svc
      .lock(ADMIN, '2026-09', new Date('2026-10-01T00:30:00Z'))
      .catch((x: unknown) => x);
    expect(err).toMatchObject({ status: 409, code: 'OPEN_SESSIONS', details: { count: 1 } });
    expect((err as Error).message).toBe(
      '1 working day dated in 2026-09 is still open. Lock the month once they have ended (End Day, or the automatic close).',
    );
  });

  it('a month that has not ended in business time cannot be locked (MONTH_NOT_ENDED)', async () => {
    const { svc, store } = setup();
    // 23:59 on 30 September in India.
    await expect(
      svc.lock(ADMIN, '2026-09', new Date('2026-09-30T18:29:00Z')),
    ).rejects.toMatchObject({
      status: 409,
      code: 'MONTH_NOT_ENDED',
    });
    await expect(
      svc.lock(ADMIN, '2026-10', new Date('2026-10-14T06:00:00Z')),
    ).rejects.toMatchObject({
      code: 'MONTH_NOT_ENDED',
    });
    expect(store.lockMonth).not.toHaveBeenCalled();
    // 00:00 on 1 October in India: September has ended.
    await expect(
      svc.lock(ADMIN, '2026-09', new Date('2026-09-30T18:30:00Z')),
    ).resolves.toMatchObject({
      locked: true,
    });
  });

  it("locks the organisation's month with a snapshot of its people (active, or worked that month) and names who locked it", async () => {
    const { svc, store, reports, reader } = setup();
    const view = await svc.lock(ADMIN, '2026-09', new Date('2026-10-02T05:00:00Z'));
    expect(view).toEqual({
      month: '2026-09',
      locked: true,
      lockedAt: '2026-10-02T05:00:00.000Z',
      lockedByName: 'Meera Nair',
      pending: 0,
    });
    expect(store.lockMonth).toHaveBeenCalledWith('c1', '2026-09', 'admin', expect.any(Function));
    expect(reader.listPeople).toHaveBeenCalledWith({
      companyId: 'c1',
      excludeRoles: ['SUPER_ADMIN'],
    });
    expect(reader.userIdsWithSessionsBetween).toHaveBeenCalledWith(
      ['x', 'y'],
      '2026-09-01',
      '2026-09-30',
    );
    expect((reports.buildMonth.mock.calls[0][0] as PersonRow[]).map((p) => p.id)).toEqual([
      'a',
      'y',
    ]);
  });

  it("a Manager sees the lock with their departments' pending count; the Admin with the organisation's", async () => {
    const { svc, approvals, store } = setup();
    const mine = await svc.status(user('m1', Role.MANAGER), '2026-09', new Date());
    expect(approvals.pendingInMonth).toHaveBeenLastCalledWith('c1', '2026-09', ['a', 'b']);
    expect(mine).toMatchObject({ locked: false, lockedAt: null, lockedByName: null, pending: 3 });
    await svc.status(ADMIN, '2026-09', new Date());
    expect(approvals.pendingInMonth).toHaveBeenLastCalledWith('c1', '2026-09');
    expect(store.findLock).toHaveBeenCalledWith('c1', '2026-09');
  });

  it('unlocks', async () => {
    const { svc, store } = setup();
    const view = await svc.unlock(ADMIN, '2026-09', new Date());
    expect(store.unlockMonth).toHaveBeenCalledWith('c1', '2026-09');
    expect(view).toMatchObject({ locked: false, pending: 3 });
  });
});

describe('ReportsService (4.0 day plans and per-day engine)', () => {
  const H = 3600;
  const NOW = new Date('2026-09-16T12:30:00Z'); // 18:00 on 16 September in India
  const staff = person('a', { department: 'Billing', designation: 'Analyst' });

  function summary(over: Partial<PersonDaySummary> = {}): PersonDaySummary {
    return {
      date: '2026-09-15',
      weekday: 2,
      workday: true,
      dayClass: 'FULL',
      startedAt: '2026-09-15T04:00:00.000Z',
      endedAt: '2026-09-15T13:00:00.000Z',
      autoClosed: false,
      lateStart: null,
      focusSec: 7.5 * H,
      expectedSec: 7.5 * H,
      breakSec: 1.5 * H,
      meetingSec: 0,
      approvedPlusSec: 0,
      rejectedMinusSec: 0,
      pendingPlusSec: 0,
      pendingMinusSec: 0,
      breaksTaken: 3,
      skipped: 0,
      autoSkipped: 0,
      overruns: 0,
      meetings: 0,
      pending: 0,
      quietHours: 0,
      activeMin: 0,
      label: null,
      targetSec: 7.5 * H,
      paidBreakSec: 1.5 * H,
      unpaidBreakSec: 0,
      awayApprovedSec: 600,
      awayPendingSec: 300,
      awayRejectedSec: 0,
      awayUnexplainedSec: 0,
      unverifiedSec: 0,
      paidSec: 9 * H,
      ...over,
    };
  }

  function plan(date: string, over: Partial<DayPlan> = {}): DayPlan {
    return {
      date,
      isWorkingDay: true,
      label: null,
      shift: null,
      bufferMin: 10,
      allowance: { scheduledSec: 80 * 60, bufferSec: 600, totalSec: 90 * 60 },
      shiftLengthSec: 9 * H,
      targetSec: 7.5 * H,
      ...over,
    };
  }

  function setup() {
    const days: Record<string, { summary: PersonDaySummary; plan: DayPlan }> = {
      '2026-09-14': {
        summary: summary({
          date: '2026-09-14',
          weekday: 1,
          dayClass: 'HALF',
          focusSec: 4 * H,
          unverifiedSec: H,
          paidSec: 5.5 * H,
        }),
        plan: plan('2026-09-14'),
      },
      '2026-09-15': { summary: summary(), plan: plan('2026-09-15') },
      '2026-09-16': {
        summary: summary({
          date: '2026-09-16',
          weekday: 3,
          workday: false,
          dayClass: 'OFF',
          startedAt: null,
          endedAt: null,
          focusSec: 0,
          targetSec: 0,
          expectedSec: 0,
          breakSec: 0,
          paidBreakSec: 0,
          awayApprovedSec: 0,
          awayPendingSec: 0,
          paidSec: 0,
          label: 'Holiday',
        }),
        plan: plan('2026-09-16', { isWorkingDay: false, label: 'Holiday', targetSec: 0 }),
      },
    };
    const personDays = {
      load: jest.fn(async () => ({
        day: (_p: unknown, date: string) => ({
          data: {
            userId: 'a',
            date,
            sessions: [],
            presence: [],
            breakRecords: [],
            meetingRecords: [],
          },
          plan: days[date]?.plan ?? plan(date),
          summary:
            days[date]?.summary ??
            summary({ date, dayClass: 'UPCOMING', focusSec: 0, startedAt: null, endedAt: null }),
        }),
      })),
    };
    const scope = {
      person: jest.fn(async (_me: unknown, id: string) => {
        if (id !== 'a') throw Object.assign(new Error('Unknown person'), { status: 404 });
        return staff;
      }),
    };
    const store = { findSnapshot: jest.fn().mockResolvedValue(null) };
    const reader = { earliestSessionDate: jest.fn().mockResolvedValue('2026-08-01') };
    const svc = new ReportsService(
      store as never,
      reader as never,
      {} as never,
      scope as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      personDays as never,
    );
    return { svc, personDays, scope, store };
  }

  it('the timesheet is one row per day from the per-day engine, with 12-hour in and out and the totals', async () => {
    const { svc, personDays } = setup();
    const t = await svc.timesheet(user('admin', Role.ADMIN), 'a', '2026-09-14', '2026-09-16', NOW);
    expect(personDays.load).toHaveBeenCalledWith([staff], '2026-09-14', '2026-09-16', NOW, {
      heal: true,
    });
    expect(t.person).toEqual({
      id: 'a',
      name: 'A Test',
      email: 'a@example.test',
      department: 'Billing',
      designation: 'Analyst',
    });
    expect(t.range).toEqual({ from: '2026-09-14', to: '2026-09-16' });
    expect(t.rows.map((r) => r.date)).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(t.rows[1]).toEqual({
      date: '2026-09-15',
      weekday: 2,
      isWorkingDay: true,
      label: null,
      in: '2026-09-15T04:00:00.000Z',
      out: '2026-09-15T13:00:00.000Z',
      in12: '9:30 AM',
      out12: '6:30 PM',
      focusSec: 7.5 * H,
      targetSec: 7.5 * H,
      breakSec: 1.5 * H,
      paidBreakSec: 1.5 * H,
      unpaidBreakSec: 0,
      meetingsSec: 0,
      awayApprovedSec: 600,
      awayPendingSec: 300,
      unverifiedSec: 0,
      paidSec: 9 * H,
      status: 'FULL',
    });
    expect(t.rows[0]).toMatchObject({ focusSec: 4 * H, unverifiedSec: H, paidSec: 5.5 * H });
    expect(t.rows[2]).toMatchObject({
      isWorkingDay: false,
      label: 'Holiday',
      targetSec: 0,
      in12: null,
      status: 'OFF',
    });
    expect(t.totals).toEqual({
      days: 3,
      workingDays: 2,
      full: 1,
      half: 1,
      absent: 0,
      focusSec: 11.5 * H,
      targetSec: 15 * H,
      breakSec: 3 * H,
      paidBreakSec: 3 * H,
      unpaidBreakSec: 0,
      meetingsSec: 0,
      awayApprovedSec: 1200,
      awayPendingSec: 600,
      unverifiedSec: H,
      paidSec: 14.5 * H,
    });
  });

  it('a range into the future loads only up to today but lists every day', async () => {
    const { svc, personDays } = setup();
    const t = await svc.timesheet(user('admin', Role.ADMIN), 'a', '2026-09-15', '2026-09-20', NOW);
    expect(personDays.load).toHaveBeenCalledWith([staff], '2026-09-15', '2026-09-16', NOW, {
      heal: true,
    });
    expect(t.rows).toHaveLength(6);
    expect(t.rows[5]).toMatchObject({ date: '2026-09-20', status: 'UPCOMING' });
  });

  it('refuses a backwards range or more than 366 days, and anyone out of scope', async () => {
    const { svc, personDays } = setup();
    await expect(
      svc.timesheet(user('admin', Role.ADMIN), 'a', '2026-09-15', '2026-09-14', NOW),
    ).rejects.toMatchObject({
      status: 400,
      details: { field: 'to' },
    });
    await expect(
      svc.timesheet(user('admin', Role.ADMIN), 'a', '2025-09-15', '2026-09-16', NOW),
    ).rejects.toMatchObject({
      status: 400,
      message: 'A timesheet covers at most 366 days.',
    });
    // Exactly 366 days is fine.
    await svc.timesheet(user('admin', Role.ADMIN), 'a', '2025-09-16', '2026-09-16', NOW);
    await expect(
      svc.timesheet(user('m1', Role.MANAGER), 'other', '2026-09-15', '2026-09-16', NOW),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(personDays.load).toHaveBeenCalledTimes(1);
  });

  it("a locked month is read from the organisation's snapshot; a Manager without the activity grant gets no hourly activity", async () => {
    const { svc, store } = setup();
    const locked = monthOf(staff, { quietHours: 4, needsALook: true });
    locked.heatmap = [{ date: '2026-08-03', hours: Array(24).fill(5) }];
    locked.days = [summary({ date: '2026-08-03', quietHours: 2, activeMin: 300 })];
    store.findSnapshot.mockResolvedValue({
      version: 1,
      generatedAt: '2026-09-02T00:00:00.000Z',
      team: {},
      persons: { a: locked },
    });

    const asAdmin = await svc.personMonth(user('admin', Role.ADMIN), 'a', '2026-08', NOW);
    expect(store.findSnapshot).toHaveBeenCalledWith('c1', '2026-08');
    expect(asAdmin).toMatchObject({ locked: true, totals: { quietHours: 4, needsALook: true } });
    expect(asAdmin.heatmap).toHaveLength(1);

    const asManager = await svc.personMonth(user('m1', Role.MANAGER), 'a', '2026-08', NOW);
    expect(asManager).toMatchObject({
      locked: true,
      heatmap: [],
      totals: { quietHours: 0, needsALook: false },
    });
    expect(asManager.days[0]).toMatchObject({ quietHours: 0, activeMin: 0 });

    const granted = await svc.personMonth(
      user('m1', Role.MANAGER, { grants: { screenshots: false, timeline: false, activity: true } }),
      'a',
      '2026-08',
      NOW,
    );
    expect(granted.heatmap).toHaveLength(1);
  });

  it("the team month's rows carry no quiet hours for a Manager without the activity grant (re-audit M4)", async () => {
    const { svc, store, scope } = setup();
    Object.assign(scope, { scope: jest.fn().mockResolvedValue([staff]) });
    const locked = monthOf(staff, { quietHours: 4, needsALook: true });
    store.findSnapshot.mockResolvedValue({
      version: 1,
      generatedAt: '2026-09-02T00:00:00.000Z',
      team: { month: '2026-08' },
      persons: { a: locked },
    });
    const asManager = await svc.teamMonth(
      user('m1', Role.MANAGER, { grants: { screenshots: true, timeline: true, activity: false } }),
      '2026-08',
      undefined,
      undefined,
      NOW,
    );
    expect(asManager.rows[0].totals).toMatchObject({ quietHours: 0, needsALook: false });
    expect(asManager.totals).toMatchObject({ quietHours: 0 });
    const asAdmin = await svc.teamMonth(
      user('admin', Role.ADMIN),
      '2026-08',
      undefined,
      undefined,
      NOW,
    );
    expect(asAdmin.rows[0].totals).toMatchObject({ quietHours: 4, needsALook: true });
  });
});
