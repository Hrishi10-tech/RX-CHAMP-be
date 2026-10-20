// Unit test for ReportActivityUseCase's End-Day capture gate: the ack's
// `shouldCapture`/`dayEnded` reflect the explicit End Day, and `clockedOut`
// (the 9h basis) is decoupled from capture — capture keeps running into
// overtime and stops only once the day is ended.
import { ActivitySampleRecord } from '../../domain/activity-sample.repository';
import { WorkDayEndRecord } from '../../domain/work-day.repository';
import { DEFAULT_WORKING_BASIS_SEC, MAX_GAP_SEC } from '../activity.constants';
import { ReportActivityUseCase } from './report-activity.use-case';

const AT = '2026-07-16T09:15:00.000Z';
const events = { publish: jest.fn(), subscribe: jest.fn() };

function sample(durationSec: number, idle = false, locked = false): ActivitySampleRecord {
  return {
    id: 'sample-id',
    userId: 'user-1',
    deviceId: null,
    date: '2026-07-16',
    at: new Date(AT),
    durationSec,
    idle,
    locked,
    app: 'Google Chrome',
    title: null,
    url: null,
  };
}

describe('ReportActivityUseCase — End Day capture gate', () => {
  const repo = {
    findLatestForUser: jest.fn(),
    findLatestForUsers: jest.fn(),
    listForUserByDate: jest.fn(),
    stampDuration: jest.fn(),
    create: jest.fn(),
  } as any;
  const access = { findSelf: jest.fn() } as any;
  const workDays = {
    findEnd: jest.fn(),
    markEnded: jest.fn(),
    recordLogin: jest.fn(),
    findLogin: jest.fn().mockResolvedValue(null),
    findLoginsForUsers: jest.fn(),
  } as any;
  const meetings = { listForUserByDate: jest.fn() } as any;
  const gateway = {
    emitToUser: jest.fn(),
    emitForSubject: jest.fn().mockResolvedValue(undefined),
  } as any;

  let useCase: ReportActivityUseCase;
  // The use case judges `at` against the server clock (future samples are
  // clamped, very old backlog is not stored), so pin the clock to the sample.
  beforeAll(() => {
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(new Date(AT).getTime() + 30_000);
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
    meetings.listForUserByDate.mockResolvedValue([]); // no meetings unless a test adds one
    repo.findLatestForUser.mockResolvedValue(null); // no previous sample to stamp
    repo.create.mockResolvedValue(sample(0)); // the freshly-created (open) sample
    repo.listForUserByDate.mockResolvedValue([]); // day rollup source (overridden per test)
    access.findSelf.mockResolvedValue(null); // no manager broadcast
  });

  it('signals capture ON when the day has not been ended', async () => {
    workDays.findEnd.mockResolvedValue(null);

    const ack = await useCase.execute('user-1', { at: AT });

    expect(workDays.findEnd).toHaveBeenCalledWith('user-1', '2026-07-16');
    expect(ack.dayEnded).toBe(false);
    expect(ack.shouldCapture).toBe(true);
  });

  it('signals capture OFF once the day has been ended', async () => {
    const end: WorkDayEndRecord = {
      userId: 'user-1',
      date: '2026-07-16',
      endedAt: new Date('2026-07-16T18:00:00.000Z'),
    };
    workDays.findEnd.mockResolvedValue(end);

    const ack = await useCase.execute('user-1', { at: AT });

    expect(ack.dayEnded).toBe(true);
    expect(ack.shouldCapture).toBe(false);
  });

  it('keeps capture ON in overtime: clockedOut is true but shouldCapture stays true', async () => {
    // Enough active seconds to cross the 9h basis (each sample capped at MAX_GAP_SEC).
    const count = Math.ceil(DEFAULT_WORKING_BASIS_SEC / MAX_GAP_SEC) + 5;
    repo.listForUserByDate.mockResolvedValue(
      Array.from({ length: count }, () => sample(MAX_GAP_SEC)),
    );
    workDays.findEnd.mockResolvedValue(null); // day still open

    const ack = await useCase.execute('user-1', { at: AT });

    expect(ack.activeSec).toBeGreaterThanOrEqual(DEFAULT_WORKING_BASIS_SEC);
    expect(ack.clockedOut).toBe(true); // past the 9h basis (overtime)
    expect(ack.shouldCapture).toBe(true); // ...but still capturing
    expect(ack.dayEnded).toBe(false);
  });

  // The screenshot switch is a separate signal on purpose: turning a user's
  // screenshots off must never look like "the day has ended", which would stop
  // their activity tracking too.
  it('passes the screenshot switch through, without touching capture or tracking', async () => {
    workDays.findEnd.mockResolvedValue(null);
    access.findSelf.mockResolvedValue({
      id: 'user-1',
      firstName: 'Uma',
      lastName: 'S',
      email: 'uma@test',
      department: null,
      managerId: null,
      screenshotsEnabled: false,
    });

    const ack = await useCase.execute('user-1', { at: AT });

    expect(ack.screenshotsEnabled).toBe(false);
    // The day is still very much running.
    expect(ack.dayEnded).toBe(false);
    expect(ack.shouldCapture).toBe(true);
    // ...and the sample was still recorded.
    expect(repo.create).toHaveBeenCalled();
  });

  it('reports the switch ON when it is enabled', async () => {
    workDays.findEnd.mockResolvedValue(null);
    access.findSelf.mockResolvedValue({
      id: 'user-1',
      firstName: 'Uma',
      lastName: 'S',
      email: 'uma@test',
      department: null,
      managerId: null,
      screenshotsEnabled: true,
    });

    const ack = await useCase.execute('user-1', { at: AT });
    expect(ack.screenshotsEnabled).toBe(true);
  });

  it('the activity:me push to staff carries no activity figures; a manager sees theirs', async () => {
    workDays.findEnd.mockResolvedValue(null);
    repo.listForUserByDate.mockResolvedValue([sample(60), sample(60)]);
    const self = {
      id: 'user-1',
      firstName: 'Uma',
      lastName: 'S',
      email: 'uma@test',
      department: null,
      managerId: 'mgr-1',
      screenshotsEnabled: true,
    };
    access.findSelf.mockResolvedValue({ ...self, role: 'USER' });
    await useCase.execute('user-1', { at: AT });
    const mine = gateway.emitToUser.mock.calls[0][1];
    expect(mine).toMatchObject({ activeSec: 0, idleSec: 0, clockedOut: false, topApps: [] });
    expect(mine.remainingSec).toBe(mine.workingBasisSec);
    expect(mine.current).toMatchObject({ app: null, title: null, url: null });
    expect(mine.current.status).toBeDefined();
    // Whoever oversees them (4.0: the organisation and department rooms) still gets the figures.
    expect(gateway.emitForSubject.mock.calls[0][0]).toBe('user-1');
    expect(gateway.emitForSubject.mock.calls[0][1].activeSec).toBeGreaterThan(0);

    gateway.emitToUser.mockClear();
    access.findSelf.mockResolvedValue({ ...self, role: 'MANAGER' });
    await useCase.execute('user-1', { at: AT });
    const managers = gateway.emitToUser.mock.calls[0][1];
    expect(managers.activeSec).toBeGreaterThan(0);
    expect(managers.current.app).toBe('Google Chrome');
  });

  it('defaults the switch ON when the user row cannot be read', async () => {
    workDays.findEnd.mockResolvedValue(null);
    access.findSelf.mockResolvedValue(null);

    const ack = await useCase.execute('user-1', { at: AT });
    // Never silently stop capturing because of a lookup miss.
    expect(ack.screenshotsEnabled).toBe(true);
  });

  it('a broadcast failure never fails the agent report', async () => {
    workDays.findEnd.mockResolvedValue(null);
    gateway.emitToUser.mockImplementation(() => {
      throw new Error('socket down');
    });

    const ack = await useCase.execute('user-1', { at: AT });

    expect(ack.ok).toBe(true);
    expect(ack.shouldCapture).toBe(true);
  });
});

// A day that has already ended is final: a late report — an in-flight sample, or
// an agent restarted after signing off — is acknowledged but never stored.
describe('ReportActivityUseCase — reports after the day has ended', () => {
  const repo = {
    findLatestForUser: jest.fn(),
    findLatestForUsers: jest.fn(),
    listForUserByDate: jest.fn(),
    stampDuration: jest.fn(),
    create: jest.fn(),
  } as any;
  const access = { findSelf: jest.fn() } as any;
  const workDays = { findEnd: jest.fn(), findEndsForUsers: jest.fn(), markEnded: jest.fn() } as any;
  const meetings = { listForUserByDate: jest.fn() } as any;
  const gateway = {
    emitToUser: jest.fn(),
    emitForSubject: jest.fn().mockResolvedValue(undefined),
  } as any;

  let useCase: ReportActivityUseCase;
  // The sample (09:15) was taken after the day was ended (09:00), and arrives at once.
  beforeAll(() => {
    jest
      .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
      .setSystemTime(new Date(AT).getTime() + 30_000);
  });
  afterAll(() => jest.useRealTimers());
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
    meetings.listForUserByDate.mockResolvedValue([]);
    repo.findLatestForUser.mockResolvedValue(null);
    repo.listForUserByDate.mockResolvedValue([]);
    access.findSelf.mockResolvedValue(null);

    const endedAt = new Date('2026-07-16T09:00:00.000Z');
    workDays.findEnd.mockResolvedValue({ userId: 'user-1', date: '2026-07-16', endedAt });
  });

  it('does not store the sample', async () => {
    await useCase.execute('user-1', { at: AT });

    expect(repo.create).not.toHaveBeenCalled();
    expect(repo.stampDuration).not.toHaveBeenCalled();
  });

  it('acknowledges with capture off so the agent stops again', async () => {
    const ack = await useCase.execute('user-1', { at: AT });

    expect(ack.dayEnded).toBe(true);
    expect(ack.shouldCapture).toBe(false);
  });

  it("does not stop today's capture for a leftover sample from an earlier ended day", async () => {
    jest.setSystemTime(new Date('2026-07-17T04:00:00.000Z'));
    try {
      // Yesterday (16 Jul) was ended; today (17 Jul) was not.
      workDays.findEnd.mockImplementation(async (_u: string, date: string) =>
        date === '2026-07-16'
          ? { userId: 'user-1', date, endedAt: new Date('2026-07-16T09:00:00.000Z') }
          : null,
      );
      const ack = await useCase.execute('user-1', { at: AT });
      expect(repo.create).not.toHaveBeenCalled();
      expect(ack.shouldCapture).toBe(true);
      expect(ack.dayEnded).toBe(false);
    } finally {
      jest.setSystemTime(new Date(AT).getTime() + 30_000);
    }
  });

  describe('a sample taken before End Day that arrives late (an offline backlog)', () => {
    beforeEach(() => {
      repo.create.mockImplementation(async (s: object) => ({ id: 'late', durationSec: 0, ...s }));
      workDays.recordLogin = jest.fn();
      workDays.findEnd.mockImplementation(async (_u: string, date: string) =>
        date === '2026-07-16'
          ? { userId: 'user-1', date, endedAt: new Date('2026-07-16T18:00:00.000Z') }
          : null,
      );
    });

    it('is stored at its own time, and the previous sample is stamped', async () => {
      jest.setSystemTime(new Date('2026-07-20T10:00:00.000Z')); // four days later
      try {
        repo.findLatestForUser.mockResolvedValue({
          ...sample(0),
          id: 'prev',
          at: new Date('2026-07-16T09:14:00.000Z'),
        });
        await useCase.execute('user-1', { at: AT, app: 'Excel', idle: false });
        expect(repo.create).toHaveBeenCalledTimes(1);
        expect(repo.create.mock.calls[0][0]).toMatchObject({
          date: '2026-07-16',
          at: new Date(AT),
          app: 'Excel',
        });
        expect(repo.stampDuration).toHaveBeenCalledWith('prev', 60);
      } finally {
        jest.setSystemTime(new Date(AT).getTime() + 30_000);
      }
    });

    it('answers with the ended-day ack for today and pushes nothing live', async () => {
      jest.setSystemTime(new Date('2026-07-20T10:00:00.000Z'));
      try {
        const ack = await useCase.execute('user-1', { at: AT });
        // Today (20 Jul) is not ended: the agent keeps capturing.
        expect(ack).toMatchObject({ dayEnded: false, shouldCapture: true });
        expect(gateway.emitToUser).not.toHaveBeenCalled();
        expect(gateway.emitForSubject).not.toHaveBeenCalled();
      } finally {
        jest.setSystemTime(new Date(AT).getTime() + 30_000);
      }
    });

    it('a sample taken after End Day is still never stored', async () => {
      jest.setSystemTime(new Date('2026-07-16T18:10:00.000Z'));
      try {
        await useCase.execute('user-1', { at: '2026-07-16T18:00:01.000Z' });
        await useCase.execute('user-1', { at: '2026-07-16T18:05:00.000Z' });
        expect(repo.create).not.toHaveBeenCalled();
        // One taken at the End Day instant itself is still the day's.
        await useCase.execute('user-1', { at: '2026-07-16T18:00:00.000Z' });
        expect(repo.create).toHaveBeenCalledTimes(1);
      } finally {
        jest.setSystemTime(new Date(AT).getTime() + 30_000);
      }
    });
  });

  it('broadcasts nothing — the board already shows DAY_ENDED', async () => {
    await useCase.execute('user-1', { at: AT });

    expect(gateway.emitToUser).not.toHaveBeenCalled();
    expect(gateway.emitForSubject).not.toHaveBeenCalled();
  });
});

describe('ReportActivityUseCase — clock checks', () => {
  const repo = {
    findLatestForUser: jest.fn().mockResolvedValue(null),
    listForUserByDate: jest.fn().mockResolvedValue([]),
    stampDuration: jest.fn(),
    create: jest.fn(),
  } as any;
  const access = { findSelf: jest.fn().mockResolvedValue(null) } as any;
  const workDays = {
    findEnd: jest.fn().mockResolvedValue(null),
    recordLogin: jest.fn(),
    findLogin: jest.fn().mockResolvedValue(null),
  } as any;
  const meetings = { listForUserByDate: jest.fn().mockResolvedValue([]) } as any;
  const gateway = {
    emitToUser: jest.fn(),
    emitForSubject: jest.fn().mockResolvedValue(undefined),
  } as any;
  const NOW = new Date('2026-10-13T09:00:00.000Z');

  beforeAll(() =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOW),
  );
  afterAll(() => jest.useRealTimers());
  beforeEach(() => {
    jest.clearAllMocks();
    repo.create.mockImplementation(async (s: any) => ({ id: 'n', durationSec: 0, ...s }));
  });

  it('never stores a sample dated in the future', async () => {
    const useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
    await useCase.execute('user-1', { at: '2026-10-14T09:00:00.000Z' });
    expect(repo.create.mock.calls[0][0].at.getTime()).toBe(NOW.getTime());
  });

  it('keeps a recent offline backlog sample at its own time', async () => {
    const useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
    await useCase.execute('user-1', { at: '2026-10-13T07:00:00.000Z' });
    expect(repo.create.mock.calls[0][0].at.toISOString()).toBe('2026-10-13T07:00:00.000Z');
  });

  it('keeps offline backlog up to the 7-day replay window', async () => {
    const useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
    await useCase.execute('user-1', { at: '2026-10-08T09:00:00.000Z' }); // 5 days old
    await useCase.execute('user-1', { at: '2026-10-06T09:00:01.000Z' }); // just inside 7 days
    expect(repo.create.mock.calls.map((c: [{ at: Date }]) => c[0].at.toISOString())).toEqual([
      '2026-10-08T09:00:00.000Z',
      '2026-10-06T09:00:01.000Z',
    ]);
  });

  it('acknowledges but does not store backlog older than 7 days', async () => {
    const useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
    const ack = await useCase.execute('user-1', { at: '2026-10-06T08:59:59.000Z' });
    expect(ack.ok).toBe(true);
    expect(repo.create).not.toHaveBeenCalled();
  });

  describe('closed days changed by samples (cached hour buckets, 4.0)', () => {
    const backfilled = () =>
      events.publish.mock.calls.filter(([name]: [string]) => name === 'activity.backfilled');

    it('a live sample changes no closed day: nothing announced', async () => {
      const useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
      repo.findLatestForUser.mockResolvedValueOnce({
        id: 'p',
        at: new Date(NOW.getTime() - 60_000),
        durationSec: 0,
      });
      await useCase.execute('user-1', { at: NOW.toISOString() });
      expect(repo.stampDuration).toHaveBeenCalledWith('p', 60);
      expect(backfilled()).toHaveLength(0);
    });

    it('an offline backlog sample, a sample of a closed session, or a stamp of an older sample is announced', async () => {
      const useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
      await useCase.execute('user-1', { at: '2026-10-13T07:00:00.000Z' }); // two hours old
      expect(backfilled()).toEqual([['activity.backfilled', { userId: 'user-1' }]]);

      events.publish.mockClear();
      await useCase.execute('user-1', { at: NOW.toISOString() }, { late: true });
      expect(backfilled()).toHaveLength(1);

      events.publish.mockClear();
      // This morning's first sample stamps yesterday's last one.
      repo.findLatestForUser.mockResolvedValueOnce({
        id: 'y',
        at: new Date('2026-10-12T13:00:00.000Z'),
        durationSec: 0,
      });
      await useCase.execute('user-1', { at: NOW.toISOString() });
      expect(repo.stampDuration).toHaveBeenCalledWith('y', MAX_GAP_SEC);
      expect(backfilled()).toHaveLength(1);
    });

    it('a sample stored for a day already ended is announced', async () => {
      const useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway, events);
      workDays.findEnd.mockResolvedValueOnce({
        userId: 'user-1',
        date: '2026-10-13',
        endedAt: new Date(NOW.getTime() + 60_000),
      });
      await useCase.execute('user-1', { at: NOW.toISOString() });
      expect(repo.create).toHaveBeenCalled();
      expect(backfilled()).toHaveLength(1);
    });
  });
});
