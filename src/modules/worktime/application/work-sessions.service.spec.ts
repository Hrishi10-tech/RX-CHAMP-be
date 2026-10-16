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
    findAnyByIds: jest
      .fn()
      .mockResolvedValue([
        { id: 'u1', firstName: 'Asha', lastName: 'Rao', managerId: 'm1', active: true },
      ]),
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
  const dayKeys = {
    keyFnFor: jest.fn(async () => dayKey),
    dayKeyAt: jest.fn(async (_userId: string, at: Date) => dayKey(at)),
  };
  const svc = new WorkSessionsService(
    repo as never,
    people as never,
    events as never,
    days as never,
    settings as never,
    dayKeys as never,
  );
  const published = () => events.publish.mock.calls.map(([name, payload]) => ({ name, payload }));
  return { svc, repo, events, days, published };
}

describe('WorkSessionsService auto-close', () => {
  it('closes a stale session at the last input and tells the person and their manager', async () => {
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
      managerId: 'm1',
      date: '2026-10-13',
    });
    const notices = p
      .filter((x) => x.name === NoticeEvent.eventName)
      .map((x) => x.payload as NoticeEvent);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({
      recipientIds: ['u1'],
      type: 'DAY_AUTO_CLOSED',
      title: 'Your day was closed at 17:45',
    });
    expect(notices[1]).toMatchObject({
      recipientIds: ['m1'],
      type: 'DAY_AUTO_CLOSED',
      title: "Asha Rao's day was closed automatically",
      fromUserId: 'u1',
    });
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
