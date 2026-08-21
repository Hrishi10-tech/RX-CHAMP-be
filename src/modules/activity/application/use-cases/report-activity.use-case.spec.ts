// Unit test for ReportActivityUseCase's End-Day capture gate: the ack's
// `shouldCapture`/`dayEnded` reflect the explicit End Day, and `clockedOut`
// (the 9h basis) is decoupled from capture — capture keeps running into
// overtime and stops only once the day is ended.
import { ActivitySampleRecord } from '../../domain/activity-sample.repository';
import { WorkDayEndRecord } from '../../domain/work-day.repository';
import { DEFAULT_WORKING_BASIS_SEC, MAX_GAP_SEC } from '../activity.constants';
import { ReportActivityUseCase } from './report-activity.use-case';

const AT = '2026-07-16T09:15:00.000Z';

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
  const gateway = { emitToUser: jest.fn(), emitToManager: jest.fn() } as any;

  let useCase: ReportActivityUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway);
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
  const gateway = { emitToUser: jest.fn(), emitToManager: jest.fn() } as any;

  let useCase: ReportActivityUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new ReportActivityUseCase(repo, access, workDays, meetings, gateway);
    meetings.listForUserByDate.mockResolvedValue([]);
    repo.findLatestForUser.mockResolvedValue(null);
    repo.listForUserByDate.mockResolvedValue([]);
    access.findSelf.mockResolvedValue(null);

    const endedAt = new Date('2026-07-16T18:00:00.000Z');
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

  it('broadcasts nothing — the board already shows DAY_ENDED', async () => {
    await useCase.execute('user-1', { at: AT });

    expect(gateway.emitToUser).not.toHaveBeenCalled();
    expect(gateway.emitToManager).not.toHaveBeenCalled();
  });
});
