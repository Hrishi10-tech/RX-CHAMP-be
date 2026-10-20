import { NoticeEvent } from '@shared/events/notice.event';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { WorkSessionRecord } from '../domain/work-session.repository';
import { WorkSessionsService } from './work-sessions.service';

// India is UTC+05:30.
const ist = (date: string, hm: string) => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi) - 330 * 60_000);
};

const SHIFT = {
  id: 'sh1',
  name: 'General',
  start: '09:30',
  end: '18:30',
  workDays: [1, 2, 3, 4, 5, 6],
  breaks: [],
};

function session(over: Partial<WorkSessionRecord> = {}): WorkSessionRecord {
  return {
    id: 's1',
    userId: 'u1',
    date: '2026-10-13',
    startedAt: ist('2026-10-13', '09:30'),
    endedAt: null,
    endReason: null,
    source: 'AGENT',
    ...over,
  };
}

/** The calendar day in India. */
const calendarKey = (at: Date) => new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
/** An 18:30 to 03:30 night shift: the early hours belong to the evening before. */
const nightKey = (at: Date) => {
  const local = new Date(at.getTime() + 330 * 60_000);
  const early = local.getUTCHours() < 4;
  return new Date(local.getTime() - (early ? 86_400_000 : 0)).toISOString().slice(0, 10);
};

function setup(
  opts: { shift?: typeof SHIFT | null; workday?: boolean; dayKey?: (at: Date) => string } = {},
) {
  const shift = opts.shift === undefined ? SHIFT : opts.shift;
  const dayKey = opts.dayKey ?? calendarKey;
  const repo = {
    findOpen: jest.fn().mockResolvedValue(null),
    listOpen: jest.fn().mockResolvedValue([]),
    lastInputs: jest.fn().mockResolvedValue(new Map()),
    autoClose: jest.fn().mockResolvedValue({ closed: true, newlyEnded: true }),
    startDay: jest.fn(),
    endDay: jest.fn(),
    ensureOpen: jest.fn(),
    openImplicit: jest.fn().mockResolvedValue(null),
    loginTimes: jest.fn().mockResolvedValue([]),
  };
  const people = {
    findAnyByIds: jest.fn().mockResolvedValue([
      {
        id: 'u1',
        firstName: 'Asha',
        lastName: 'Rao',
        role: 'USER',
        departmentId: 'd1',
        managerId: null,
        companyId: 'co-1',
        active: true,
      },
    ]),
    // 4.0: the department's managers oversee Staff; with none, the Admin.
    listDepartmentManagerIds: jest.fn().mockResolvedValue(['m1']),
    listOrgAdminIds: jest.fn().mockResolvedValue(['a1']),
  };
  const events = {
    publish: jest.fn(async (_n: string, _p: unknown) => undefined),
    subscribe: jest.fn(),
  };
  const days = {
    context: jest.fn().mockResolvedValue({}),
    resolveWith: jest.fn().mockReturnValue({ shift }),
    forDate: jest.fn((resolved: { shift: unknown }) => ({
      resolved,
      workday: opts.workday ?? true,
      slots: [],
    })),
  };
  const settings = { get: jest.fn().mockResolvedValue({ autoCloseAfterShiftEndMin: 240 }) };
  const breakRecords = { endPaused: jest.fn().mockResolvedValue(0) };
  const dayKeys = {
    keyFnFor: jest.fn(async () => dayKey),
    dayKeyAt: jest.fn(async (_userId: string, at: Date) => dayKey(at)),
  };
  const svc = new WorkSessionsService(
    repo as never,
    people as never,
    breakRecords as never,
    events as never,
    days as never,
    settings as never,
    dayKeys as never,
  );
  const published = () => events.publish.mock.calls.map(([name, payload]) => ({ name, payload }));
  return { svc, repo, events, days, published, settings, people, breakRecords };
}

describe('WorkSessionsService auto-close', () => {
  it('closes a stale session at the last input and tells the person and their department managers', async () => {
    const { svc, repo, published } = setup();
    repo.listOpen.mockResolvedValue([session()]);
    repo.lastInputs.mockResolvedValue(new Map([['s1', ist('2026-10-13', '17:45')]]));
    const now = ist('2026-10-14', '08:00');

    expect(await svc.autoCloseAll(now)).toBe(1);

    expect(repo.autoClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's1' }),
      ist('2026-10-13', '17:45'),
    );
    const p = published();
    expect(p[0].name).toBe(DayEndedEvent.eventName);
    expect(p[0].payload).toMatchObject({
      userId: 'u1',
      userName: 'Asha Rao',
      // The notifications module resolves who oversees the person.
      managerId: null,
      date: '2026-10-13',
    });
    const notices = p
      .filter((x) => x.name === NoticeEvent.eventName)
      .map((x) => x.payload as NoticeEvent);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({
      recipientIds: ['u1'],
      type: 'DAY_AUTO_CLOSED',
      // 4.0: 12-hour times in every backend-built string.
      title: 'Your day was closed at 5:45 PM',
    });
    expect(notices[1]).toMatchObject({
      recipientIds: ['m1'],
      type: 'DAY_AUTO_CLOSED',
      title: "Asha Rao's day was closed automatically",
      fromUserId: 'u1',
    });
  });

  it("tells the Admin when the department has no manager, and a Manager's Admin", async () => {
    const { svc, repo, published, people } = setup();
    people.listDepartmentManagerIds.mockResolvedValue([]);
    repo.listOpen.mockResolvedValue([session()]);
    await svc.autoCloseAll(ist('2026-10-14', '08:00'));
    const toAdmin = published()
      .filter((x) => x.name === NoticeEvent.eventName)
      .map((x) => x.payload as NoticeEvent);
    expect(toAdmin[1]).toMatchObject({ recipientIds: ['a1'] });

    const second = setup();
    second.people.findAnyByIds.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'Asha',
        lastName: 'Rao',
        role: 'MANAGER',
        departmentId: 'd1',
        managerId: null,
        companyId: 'co-1',
        active: true,
      },
    ]);
    second.repo.listOpen.mockResolvedValue([session()]);
    await second.svc.autoCloseAll(ist('2026-10-14', '08:00'));
    const notices = second
      .published()
      .filter((x) => x.name === NoticeEvent.eventName)
      .map((x) => x.payload as NoticeEvent);
    expect(notices[1]).toMatchObject({ recipientIds: ['a1'] });
    expect(second.people.listDepartmentManagerIds).not.toHaveBeenCalled();
  });

  it('leaves a session alone until shift end + 240 minutes has passed', async () => {
    const { svc, repo } = setup();
    repo.listOpen.mockResolvedValue([session()]);
    expect(await svc.autoCloseAll(ist('2026-10-13', '22:30'))).toBe(0);
    expect(repo.autoClose).not.toHaveBeenCalled();
    expect(await svc.autoCloseAll(ist('2026-10-13', '22:31'))).toBe(1);
  });

  it('closes at the start (zero length) with no input, and never past latestEnd', async () => {
    const { svc, repo } = setup();
    repo.listOpen.mockResolvedValue([session()]);
    await svc.autoCloseAll(ist('2026-10-14', '08:00'));
    expect(repo.autoClose).toHaveBeenLastCalledWith(expect.anything(), ist('2026-10-13', '09:30'));

    repo.lastInputs.mockResolvedValue(new Map([['s1', ist('2026-10-14', '01:00')]]));
    await svc.autoCloseAll(ist('2026-10-14', '08:00'));
    expect(repo.autoClose).toHaveBeenLastCalledWith(expect.anything(), ist('2026-10-13', '22:30'));
  });

  it("uses each person's organisation's auto-close minutes (settings are per organisation)", async () => {
    const { svc, repo, settings, people } = setup();
    people.findAnyByIds.mockResolvedValue([
      {
        id: 'u1',
        firstName: 'Asha',
        lastName: 'Rao',
        role: 'USER',
        departmentId: 'd1',
        managerId: null,
        companyId: 'co-1',
        active: true,
      },
      {
        id: 'u2',
        firstName: 'Ravi',
        lastName: 'K',
        role: 'USER',
        departmentId: 'd2',
        managerId: null,
        companyId: 'co-2',
        active: true,
      },
    ]);
    settings.get.mockImplementation(async (companyId?: string | null) => ({
      autoCloseAfterShiftEndMin: companyId === 'co-2' ? 60 : 240,
    }));
    repo.listOpen.mockResolvedValue([session(), session({ id: 's2', userId: 'u2' })]);
    // 19:31: past co-2's shift end + 60 min, not co-1's + 240 min.
    expect(await svc.autoCloseAll(ist('2026-10-13', '19:31'))).toBe(1);
    expect(repo.autoClose).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's2' }),
      expect.any(Date),
    );
    expect(settings.get).toHaveBeenCalledWith('co-2');
  });

  it('uses start + 14 hours without a shift or on a day off', async () => {
    const { svc, repo } = setup({ workday: false });
    repo.listOpen.mockResolvedValue([session({ startedAt: ist('2026-10-13', '10:00') })]);
    expect(await svc.autoCloseAll(ist('2026-10-14', '00:00'))).toBe(0);
    expect(await svc.autoCloseAll(ist('2026-10-14', '00:01'))).toBe(1);
  });

  it('a session resumed late in the evening is not closed the moment it opens', async () => {
    const { svc, repo } = setup();
    repo.listOpen.mockResolvedValue([session({ id: 's2', startedAt: ist('2026-10-13', '23:00') })]);
    expect(await svc.autoCloseAll(ist('2026-10-13', '23:30'))).toBe(0);
    expect(await svc.autoCloseAll(ist('2026-10-14', '03:01'))).toBe(1);
  });

  it('sends nothing when End Day won the race, and only notices when the day was already ended', async () => {
    const { svc, repo, events, published } = setup();
    repo.listOpen.mockResolvedValue([session()]);
    repo.autoClose.mockResolvedValueOnce({ closed: false, newlyEnded: false });
    expect(await svc.autoCloseAll(ist('2026-10-14', '08:00'))).toBe(0);
    expect(events.publish).not.toHaveBeenCalled();

    repo.autoClose.mockResolvedValueOnce({ closed: true, newlyEnded: false });
    await svc.autoCloseAll(ist('2026-10-14', '08:00'));
    expect(published().map((p) => p.name)).toEqual([NoticeEvent.eventName, NoticeEvent.eventName]);
  });

  it('a day closed again after a replayed action reopened it announces nothing (re-audit M2)', async () => {
    const { svc, repo, events } = setup();
    repo.listOpen.mockResolvedValue([session()]);
    repo.autoClose.mockResolvedValueOnce({ closed: true, newlyEnded: true, reclosed: true });
    expect(await svc.autoCloseAll(ist('2026-10-14', '08:00'))).toBe(1);
    expect(events.publish).not.toHaveBeenCalled();
  });

  it("a day's latest end is what the replay interceptor is told (no reopen past it)", async () => {
    const { svc } = setup();
    const s = session();
    // The same limit the automatic close and a late input's move use.
    const viaClose = await svc.latestEndOfSession(s);
    expect(viaClose.getTime()).toBeGreaterThan(s.startedAt.getTime());
    expect(
      await svc.latestEndOfSession({ userId: s.userId, date: s.date, startedAt: s.startedAt }),
    ).toEqual(viaClose);
  });

  it('one failing session does not stop the others', async () => {
    const { svc, repo } = setup();
    repo.listOpen.mockResolvedValue([session(), session({ id: 's9', userId: 'u1' })]);
    repo.autoClose.mockRejectedValueOnce(new Error('deadlock'));
    expect(await svc.autoCloseAll(ist('2026-10-14', '08:00'))).toBe(1);
  });

  it('the lazy check reuses the computed latest end for a few minutes', async () => {
    const { svc, repo, days } = setup();
    repo.findOpen.mockResolvedValue(session());
    expect(await svc.autoCloseIfStale('u1', ist('2026-10-13', '12:00'))).toBe(false);
    expect(await svc.autoCloseIfStale('u1', ist('2026-10-13', '12:03'))).toBe(false);
    expect(days.context).toHaveBeenCalledTimes(1);
    expect(await svc.autoCloseIfStale('u1', ist('2026-10-13', '12:06'))).toBe(false);
    expect(days.context).toHaveBeenCalledTimes(2);
    repo.findOpen.mockResolvedValue(null);
    expect(await svc.autoCloseIfStale('u1', ist('2026-10-14', '12:00'))).toBe(false);
  });
});

describe('WorkSessionsService day state', () => {
  it('Start Day records who opened it: a 3.1 agent AGENT, anything older LEGACY', async () => {
    const { svc, repo } = setup();
    const now = ist('2026-10-14', '09:30');
    await svc.startDay('u1', now, 'AGENT_31', now);
    expect(repo.startDay).toHaveBeenLastCalledWith('u1', now, now, 'AGENT', expect.any(Function));
    await svc.startDay('u1', now, 'LEGACY', now);
    expect(repo.startDay).toHaveBeenLastCalledWith('u1', now, now, 'LEGACY', expect.any(Function));
  });

  it("Start Day dates the session by the person's shift-day (a night shift's early hours)", async () => {
    const { svc, repo } = setup({ dayKey: nightKey });
    const now = ist('2026-10-15', '00:40');
    await svc.startDay('u1', now, 'AGENT_31', now);
    const dayOf = repo.startDay.mock.calls[0][4] as (at: Date) => string;
    expect(dayOf(now)).toBe('2026-10-14');
    expect(dayOf(ist('2026-10-15', '19:00'))).toBe('2026-10-15');
  });

  it('End Day first ends a paused break at its pause (4.0)', async () => {
    const { svc, repo, breakRecords } = setup();
    const now = ist('2026-10-14', '18:30');
    await svc.endDay('u1', 'AGENT_31', now);
    expect(breakRecords.endPaused).toHaveBeenCalledWith('u1');
    expect(breakRecords.endPaused.mock.invocationCallOrder[0]).toBeLessThan(
      repo.endDay.mock.invocationCallOrder[0],
    );
  });

  it('End Day on a night shift after midnight ends the shift-day it started on', async () => {
    const { svc, repo } = setup({ dayKey: nightKey });
    const now = ist('2026-10-15', '03:35');
    await svc.endDay('u1', 'AGENT_31', now);
    expect(repo.endDay).toHaveBeenLastCalledWith('u1', now, '2026-10-14', false, expect.any(Date));
  });

  it('End Day passes the business day, whether the caller is legacy, and the last 12 hours', async () => {
    const { svc, repo } = setup();
    const now = ist('2026-10-14', '00:30');
    const since = new Date(now.getTime() - 12 * 3600_000);
    await svc.endDay('u1', 'LEGACY', now);
    expect(repo.endDay).toHaveBeenLastCalledWith('u1', now, '2026-10-14', true, since);
    await svc.endDay('u1', 'AGENT_31', now);
    expect(repo.endDay).toHaveBeenLastCalledWith('u1', now, '2026-10-14', false, since);
  });

  it('an action on a closed day is 409 DAY_NOT_STARTED or DAY_ENDED', async () => {
    const { svc, repo } = setup();
    const now = ist('2026-10-14', '10:00');
    repo.ensureOpen.mockResolvedValueOnce({ ok: false, code: 'DAY_NOT_STARTED' });
    await expect(svc.ensureOpen('u1', 'AGENT_31', now)).rejects.toMatchObject({
      status: 409,
      code: 'DAY_NOT_STARTED',
    });
    repo.ensureOpen.mockResolvedValueOnce({ ok: false, code: 'DAY_ENDED' });
    await expect(svc.ensureOpen('u1', 'AGENT_31', now)).rejects.toMatchObject({
      status: 409,
      code: 'DAY_ENDED',
    });
    repo.ensureOpen.mockResolvedValueOnce({ ok: true, session: session(), implicit: true });
    await expect(svc.ensureOpen('u1', 'LEGACY', now)).resolves.toMatchObject({ id: 's1' });
  });

  it('a legacy sample from another day never opens today', async () => {
    const { svc, repo } = setup();
    const now = ist('2026-10-14', '00:10');
    expect(await svc.openImplicitForSample('u1', ist('2026-10-13', '23:55'), now)).toBeNull();
    expect(repo.openImplicit).not.toHaveBeenCalled();
    await svc.openImplicitForSample('u1', ist('2026-10-14', '00:05'), now);
    expect(repo.openImplicit).toHaveBeenCalledWith('u1', ist('2026-10-14', '00:05'), '2026-10-14');
  });

  it('a legacy session opens at the PC sign-in already reported for this working day', async () => {
    const { svc, repo } = setup();
    const now = ist('2026-10-14', '11:00');
    repo.loginTimes.mockResolvedValue([ist('2026-10-14', '09:12')]);
    await svc.openImplicitForSample('u1', ist('2026-10-14', '10:59'), now);
    expect(repo.loginTimes).toHaveBeenCalledWith('u1', ['2026-10-14', '2026-10-14']);
    expect(repo.openImplicit).toHaveBeenLastCalledWith(
      'u1',
      ist('2026-10-14', '09:12'),
      '2026-10-14',
    );
  });

  it('a sign-in in the future or on another working day is not used', async () => {
    const { svc, repo } = setup();
    const now = ist('2026-10-14', '11:00');
    repo.loginTimes.mockResolvedValue([ist('2026-10-14', '11:30'), ist('2026-10-13', '23:50')]);
    await svc.openImplicitForSample('u1', ist('2026-10-14', '10:58'), now);
    expect(repo.openImplicit).toHaveBeenLastCalledWith(
      'u1',
      ist('2026-10-14', '10:58'),
      '2026-10-14',
    );
  });

  it("a night shift's legacy session after midnight opens at the evening sign-in", async () => {
    const { svc, repo } = setup({ dayKey: nightKey });
    const now = ist('2026-10-15', '00:30');
    repo.loginTimes.mockResolvedValue([ist('2026-10-14', '18:41')]);
    await svc.openImplicitForSample('u1', ist('2026-10-15', '00:29'), now);
    // The shift-day (14th) and the calendar day (15th) are both asked for.
    expect(repo.loginTimes).toHaveBeenCalledWith('u1', ['2026-10-14', '2026-10-15']);
    expect(repo.openImplicit).toHaveBeenLastCalledWith(
      'u1',
      ist('2026-10-14', '18:41'),
      '2026-10-14',
    );
  });

  it("a legacy sample's own time is trusted only 10 minutes back", async () => {
    const { svc, repo } = setup();
    const now = ist('2026-10-14', '11:00');
    await svc.openImplicitForSample('u1', ist('2026-10-14', '08:00'), now);
    expect(repo.openImplicit).toHaveBeenLastCalledWith(
      'u1',
      ist('2026-10-14', '10:50'),
      '2026-10-14',
    );
    await svc.openImplicitForSample('u1', ist('2026-10-14', '10:55'), now);
    expect(repo.openImplicit).toHaveBeenLastCalledWith(
      'u1',
      ist('2026-10-14', '10:55'),
      '2026-10-14',
    );
  });
});

/** The repository fake, to give it the methods a test needs. */
const stub = (repo: unknown) => repo as Record<string, jest.Mock>;

describe('WorkSessionsService.extendAutoClosed (an input that arrives after the auto-close)', () => {
  // General: 09:30 to 18:30, auto-close 240 min after the shift end: latest end 22:30.
  const autoClosed = (over: Partial<WorkSessionRecord> = {}) =>
    session({
      endedAt: ist('2026-10-13', '09:30'),
      endReason: 'AUTO_CLOSED',
      source: 'REPLAY',
      ...over,
    });

  it('moves the close to the late input, inside the latest end', async () => {
    const { svc, repo } = setup();
    const s = autoClosed();
    stub(repo).lastStartedAtOrBefore = jest.fn().mockResolvedValue(s);
    stub(repo).extendAutoClosed = jest.fn().mockResolvedValue(true);
    expect(await svc.extendAutoClosed('u1', ist('2026-10-13', '11:00'))).toBe(true);
    expect(stub(repo).lastStartedAtOrBefore).toHaveBeenCalledWith('u1', ist('2026-10-13', '11:00'));
    expect(stub(repo).extendAutoClosed).toHaveBeenCalledWith(s, ist('2026-10-13', '11:00'));
    // At the close itself: nothing to move, the day already runs to it.
    stub(repo).extendAutoClosed.mockClear();
    expect(await svc.extendAutoClosed('u1', ist('2026-10-13', '09:30'))).toBe(true);
    expect(stub(repo).extendAutoClosed).not.toHaveBeenCalled();
  });

  it.each([
    ['after the latest end', autoClosed(), ist('2026-10-13', '22:31')],
    ['a day the person ended', autoClosed({ endReason: 'USER' }), ist('2026-10-13', '11:00')],
    ['a session still open', session(), ist('2026-10-13', '11:00')],
    [
      'before the close (inside the session already)',
      autoClosed({ endedAt: ist('2026-10-13', '12:00') }),
      ist('2026-10-13', '11:00'),
    ],
  ])('never for an input %s', async (_why, s, at) => {
    const { svc, repo } = setup();
    stub(repo).lastStartedAtOrBefore = jest.fn().mockResolvedValue(s);
    stub(repo).extendAutoClosed = jest.fn().mockResolvedValue(true);
    expect(await svc.extendAutoClosed('u1', at)).toBe(false);
    expect(stub(repo).extendAutoClosed).not.toHaveBeenCalled();
  });

  it('nothing to extend when there is no earlier session', async () => {
    const { svc, repo } = setup();
    stub(repo).lastStartedAtOrBefore = jest.fn().mockResolvedValue(null);
    expect(await svc.extendAutoClosed('u1', ist('2026-10-13', '11:00'))).toBe(false);
  });
});

describe('WorkSessionsService.workedAt (late activity samples)', () => {
  it('is true inside a work session, open or closed, and false outside every one', async () => {
    const { svc, repo } = setup();
    const closed = session({ endedAt: ist('2026-10-13', '18:30'), endReason: 'USER' });
    const overlapping = jest.fn().mockResolvedValue([closed]);
    stub(repo).listOverlapping = overlapping;
    expect(await svc.workedAt('u1', ist('2026-10-13', '12:00'))).toBe(true);
    expect(await svc.workedAt('u1', ist('2026-10-13', '09:30'))).toBe(true);
    // The end is not inside (a sample at End Day or later belongs to no session).
    expect(await svc.workedAt('u1', ist('2026-10-13', '18:30'))).toBe(false);
    expect(await svc.workedAt('u1', ist('2026-10-13', '09:29'))).toBe(false);
    expect(overlapping).toHaveBeenCalledWith(
      ['u1'],
      ist('2026-10-13', '09:29'),
      ist('2026-10-13', '09:29'),
    );
    overlapping.mockResolvedValue([session()]);
    expect(await svc.workedAt('u1', ist('2026-10-14', '02:00'))).toBe(true);
    overlapping.mockResolvedValue([]);
    expect(await svc.workedAt('u1', ist('2026-10-13', '12:00'))).toBe(false);
  });
});
