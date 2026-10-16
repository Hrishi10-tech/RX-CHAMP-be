import { AppException } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { NoticeEvent } from '@shared/events/notice.event';
import { PersonRow } from '@modules/worktime/domain/worktime.reader';
import { emptyTotals } from '../domain/report-builder';
import { PersonMonthReport, TeamMonthReport } from '../domain/report.types';
import { MonthLockService } from './month-lock.service';
import { ReportRunsService, runSummary } from './report-runs.service';
import { reportPerson } from './reports.service';

const user = (id: string, role: Role): AuthenticatedUser =>
  ({ id, role, email: `${id}@example.test`, permissions: [] }) as unknown as AuthenticatedUser;

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

describe('ReportRunsService', () => {
  const sa = person('sa', { role: 'SUPER_ADMIN' });
  const m1 = person('m1', { role: 'MANAGER', managerId: 'sa' });
  const m2 = person('m2', { role: 'MANAGER', active: false });
  const a = person('a', { managerId: 'm1' });
  const b = person('b', { managerId: 'm2' });
  const c = person('c', { managerId: 'm1', active: false });
  const d = person('d', { managerId: 'm1', active: false });

  function setup() {
    const store = {
      upsertRun: jest.fn().mockResolvedValue(undefined),
      listRuns: jest.fn(),
      runKeys: jest.fn().mockResolvedValue(new Set<string>()),
      // 3.1 has been running since August.
      recordFirstBoot: jest.fn().mockResolvedValue(new Date('2026-08-03T04:00:00Z')),
    };
    const reader = {
      listPeople: jest.fn().mockResolvedValue([sa, m1, m2, a, b, c, d]),
      userIdsWithSessionsBetween: jest.fn().mockResolvedValue(new Set(['c'])),
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

  it('builds the month once and stores one run per active Manager (team) and Super Admin (everyone)', async () => {
    const { svc, store, reader, events, reports } = setup();
    const n = await svc.generate('2026-09', new Date('2026-09-30T19:00:00Z'));
    expect(n).toBe(2);
    expect(reader.userIdsWithSessionsBetween).toHaveBeenCalledWith(
      ['m2', 'c', 'd'],
      '2026-09-01',
      '2026-09-30',
    );
    expect(reports.buildMonth).toHaveBeenCalledTimes(1);
    expect((reports.buildMonth.mock.calls[0][0] as PersonRow[]).map((p) => p.id)).toEqual([
      'sa',
      'm1',
      'a',
      'b',
      'c',
    ]);
    expect(store.upsertRun).toHaveBeenCalledWith(
      '2026-09',
      'ALL',
      'sa',
      expect.objectContaining({ people: 5 }),
    );
    // m1's team: a and c (c is inactive but worked in September).
    expect(store.upsertRun).toHaveBeenCalledWith(
      '2026-09',
      'TEAM',
      'm1',
      expect.objectContaining({ people: 2 }),
    );
    expect(events.publish).toHaveBeenCalledTimes(2);
    const notice = events.publish.mock.calls[0][1] as NoticeEvent;
    expect(notice.type).toBe('MONTHLY_REPORT_READY');
    expect(notice.title).toBe('September 2026 report is ready');
  });

  it('the job builds the previous month and never throws', async () => {
    const { svc, reports } = setup();
    // 00:30 on 1 October in India is 19:00 UTC on 30 September.
    await svc.run(new Date('2026-09-30T19:00:00Z'));
    expect(reports.buildMonth.mock.calls[0][1]).toBe('2026-09');
    reports.buildMonth.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.run(new Date('2026-09-30T19:00:00Z'))).resolves.toBeUndefined();
  });

  it('the previous month in business time, whatever the day', () => {
    expect(ReportRunsService.previousMonth(new Date('2026-10-14T06:00:00Z'))).toBe('2026-09');
    // 00:10 on 1 January in India is still 31 December in UTC.
    expect(ReportRunsService.previousMonth(new Date('2026-12-31T18:40:00Z'))).toBe('2026-12');
    expect(ReportRunsService.previousMonth(new Date('2027-01-01T06:00:00Z'))).toBe('2026-12');
  });

  it('catch-up (boot and 01:00): only the owners still missing a run, and nothing twice', async () => {
    const { svc, store, reader, reports, events } = setup();
    reader.userIdsWithSessionsBetween.mockResolvedValue(new Set(['a']));
    store.runKeys.mockResolvedValueOnce(new Set(['ALL|sa']));
    await svc.catchUp(new Date('2026-10-02T06:00:00Z'));
    expect(store.runKeys).toHaveBeenCalledWith('2026-09');
    expect(reports.buildMonth).toHaveBeenCalledTimes(1);
    expect(store.upsertRun).toHaveBeenCalledTimes(1);
    expect(store.upsertRun).toHaveBeenCalledWith('2026-09', 'TEAM', 'm1', expect.anything());
    expect(events.publish).toHaveBeenCalledTimes(1);

    // Every owner has a run now: nothing is built or sent again.
    store.runKeys.mockResolvedValueOnce(new Set(['ALL|sa', 'TEAM|m1']));
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
    expect(reports.buildMonth).toHaveBeenCalledTimes(1);
  });
});

describe('MonthLockService', () => {
  function setup(
    lockResult: unknown = {
      ok: true,
      lock: { month: '2026-09', lockedById: 'sa', lockedAt: new Date('2026-10-02T05:00:00Z') },
      created: true,
    },
  ) {
    const store = {
      lockMonth: jest.fn(async (_m: string, _by: string, build: () => Promise<unknown>) => {
        await build();
        return lockResult;
      }),
      findLock: jest.fn().mockResolvedValue(null),
      unlockMonth: jest.fn().mockResolvedValue(true),
    };
    const approvals = { pendingInMonth: jest.fn().mockResolvedValue(3) };
    const reader = {
      listPeople: jest.fn().mockResolvedValue([person('a'), person('x', { active: false })]),
      userIdsWithSessionsBetween: jest.fn().mockResolvedValue(new Set()),
    };
    const people = {
      findAnyByIds: jest
        .fn()
        .mockResolvedValue([{ id: 'sa', firstName: 'Meera', lastName: 'Nair' }]),
    };
    const scope = { scope: jest.fn().mockResolvedValue([person('a'), person('b')]) };
    const reports = {
      assertMonthInRange: jest.fn().mockResolvedValue(undefined),
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
    return { svc, store, approvals, scope, reports };
  }

  it('only a Super Admin locks or unlocks', async () => {
    const { svc, store } = setup();
    const mgr = user('m1', Role.MANAGER);
    await expect(svc.lock(mgr, '2026-09', new Date())).rejects.toMatchObject({ status: 403 });
    await expect(svc.unlock(mgr, '2026-09', new Date())).rejects.toMatchObject({ status: 403 });
    expect(store.lockMonth).not.toHaveBeenCalled();
  });

  it('refuses while items are pending, with the count', async () => {
    const { svc } = setup({ ok: false, reason: 'PENDING_APPROVALS', count: 2 });
    const err = await svc
      .lock(user('sa', Role.SUPER_ADMIN), '2026-09', new Date('2026-10-02T05:00:00Z'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    expect(err).toMatchObject({ status: 409, code: 'PENDING_APPROVALS', details: { count: 2 } });
    expect((err as Error).message).toBe(
      '2 items dated in 2026-09 still wait for a decision. Decide them before locking the month.',
    );
  });

  it('refuses while a working day dated in the month is still open, with the count', async () => {
    const { svc } = setup({ ok: false, reason: 'OPEN_SESSIONS', count: 1 });
    const err = await svc
      .lock(user('sa', Role.SUPER_ADMIN), '2026-09', new Date('2026-10-01T00:30:00Z'))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'OPEN_SESSIONS', details: { count: 1 } });
    expect((err as Error).message).toBe(
      '1 working day dated in 2026-09 is still open. Lock the month once they have ended (End Day, or the automatic close).',
    );
  });

  it('a month that has not ended in business time cannot be locked (MONTH_NOT_ENDED)', async () => {
    const { svc, store } = setup();
    const sa = user('sa', Role.SUPER_ADMIN);
    // 23:59 on 30 September in India.
    await expect(svc.lock(sa, '2026-09', new Date('2026-09-30T18:29:00Z'))).rejects.toMatchObject({
      status: 409,
      code: 'MONTH_NOT_ENDED',
    });
    await expect(svc.lock(sa, '2026-10', new Date('2026-10-14T06:00:00Z'))).rejects.toMatchObject({
      code: 'MONTH_NOT_ENDED',
    });
    expect(store.lockMonth).not.toHaveBeenCalled();
    // 00:00 on 1 October in India: September has ended.
    await expect(svc.lock(sa, '2026-09', new Date('2026-09-30T18:30:00Z'))).resolves.toMatchObject({
      locked: true,
    });
  });

  it('locks with a snapshot of everyone (active, or worked that month) and names who locked it', async () => {
    const { svc, store, reports } = setup();
    const view = await svc.lock(
      user('sa', Role.SUPER_ADMIN),
      '2026-09',
      new Date('2026-10-02T05:00:00Z'),
    );
    expect(view).toEqual({
      month: '2026-09',
      locked: true,
      lockedAt: '2026-10-02T05:00:00.000Z',
      lockedByName: 'Meera Nair',
      pending: 0,
    });
    expect(store.lockMonth).toHaveBeenCalledWith('2026-09', 'sa', expect.any(Function));
    expect((reports.buildMonth.mock.calls[0][0] as PersonRow[]).map((p) => p.id)).toEqual(['a']);
  });

  it('a Manager sees the lock with their own team pending count; a Super Admin with everyone', async () => {
    const { svc, approvals } = setup();
    const mine = await svc.status(user('m1', Role.MANAGER), '2026-09', new Date());
    expect(approvals.pendingInMonth).toHaveBeenLastCalledWith('2026-09', ['a', 'b']);
    expect(mine).toMatchObject({ locked: false, lockedAt: null, lockedByName: null, pending: 3 });
    await svc.status(user('sa', Role.SUPER_ADMIN), '2026-09', new Date());
    expect(approvals.pendingInMonth).toHaveBeenLastCalledWith('2026-09');
  });

  it('unlocks', async () => {
    const { svc, store } = setup();
    const view = await svc.unlock(user('sa', Role.SUPER_ADMIN), '2026-09', new Date());
    expect(store.unlockMonth).toHaveBeenCalledWith('2026-09');
    expect(view).toMatchObject({ locked: false, pending: 3 });
  });
});
