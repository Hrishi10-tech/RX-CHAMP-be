// Unit test for EndDayUseCase — marks the current local day ended (deriving the
// day from the given timestamp), freezes the day by closing the trailing open
// sample at that instant, announces it, and is idempotent (a second press keeps
// the original end time and fires nothing).
import { MarkEndedResult } from '../../domain/work-day.repository';
import { DayEndedEvent } from '../../domain/events/day-ended.event';
import { localDateString } from '../activity-date.util';
import { EndDayUseCase } from './end-day.use-case';

describe('EndDayUseCase', () => {
  const workDays = { findEnd: jest.fn(), findEndsForUsers: jest.fn(), markEnded: jest.fn() } as any;
  const samples = {
    findLatestForUser: jest.fn(),
    listForUserByDate: jest.fn(),
    stampDuration: jest.fn(),
  } as any;
  const access = { findSelf: jest.fn(), findReports: jest.fn(), findManagerId: jest.fn() } as any;
  const meetings = { listForUserByDate: jest.fn() } as any;
  const events = { publish: jest.fn(), subscribe: jest.fn() } as any;
  const gateway = { emitToUser: jest.fn(), emitToManager: jest.fn() } as any;

  let useCase: EndDayUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new EndDayUseCase(workDays, samples, access, meetings, events, gateway);

    // By default the repo echoes back what it was asked to persist, as a first end.
    workDays.markEnded.mockImplementation(
      async (userId: string, date: string, endedAt: Date): Promise<MarkEndedResult> => ({
        record: { userId, date, endedAt },
        created: true,
      }),
    );
    samples.findLatestForUser.mockResolvedValue(null);
    samples.listForUserByDate.mockResolvedValue([]);
    meetings.listForUserByDate.mockResolvedValue([]);
    access.findSelf.mockResolvedValue(undefined);
  });

  it('marks the day ended using the local day derived from the timestamp', async () => {
    const at = new Date('2026-07-21T13:05:00.000Z');
    const expectedDate = localDateString(at);

    const result = await useCase.execute('user-1', at);

    expect(workDays.markEnded).toHaveBeenCalledTimes(1);
    expect(workDays.markEnded).toHaveBeenCalledWith('user-1', expectedDate, at);
    expect(result).toEqual({ ok: true, date: expectedDate, endedAt: at.toISOString() });
  });

  it('defaults the timestamp to now when none is given', async () => {
    await useCase.execute('user-1');

    expect(workDays.markEnded).toHaveBeenCalledTimes(1);
    const [userId, date, endedAt] = workDays.markEnded.mock.calls[0];
    expect(userId).toBe('user-1');
    expect(endedAt).toBeInstanceOf(Date);
    // The day passed in must be the local day of the timestamp used.
    expect(date).toBe(localDateString(endedAt));
  });

  it('closes the trailing open sample at the End Day instant, not at "now"', async () => {
    const at = new Date('2026-07-21T13:05:00.000Z');
    samples.findLatestForUser.mockResolvedValue({
      id: 'sample-9',
      at: new Date('2026-07-21T13:04:00.000Z'), // one minute before the press
      durationSec: 0, // still open
    });

    await useCase.execute('user-1', at);

    expect(samples.stampDuration).toHaveBeenCalledWith('sample-9', 60);
  });

  it('leaves an already-stamped sample alone', async () => {
    samples.findLatestForUser.mockResolvedValue({
      id: 'sample-9',
      at: new Date('2026-07-21T13:04:00.000Z'),
      durationSec: 42, // already closed
    });

    await useCase.execute('user-1', new Date('2026-07-21T13:05:00.000Z'));

    expect(samples.stampDuration).not.toHaveBeenCalled();
  });

  it('publishes DayEndedEvent with the manager to notify', async () => {
    const at = new Date('2026-07-21T13:05:00.000Z');
    access.findSelf.mockResolvedValue({
      id: 'user-1',
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha@example.com',
      department: null,
      managerId: 'mgr-7',
    });

    await useCase.execute('user-1', at);

    expect(events.publish).toHaveBeenCalledTimes(1);
    const [name, payload] = events.publish.mock.calls[0];
    expect(name).toBe(DayEndedEvent.eventName);
    expect(payload).toMatchObject({
      userId: 'user-1',
      userName: 'Asha Rao',
      managerId: 'mgr-7',
      endedAt: at,
    });
  });

  it('pushes DAY_ENDED to the user and their manager straight away', async () => {
    access.findSelf.mockResolvedValue({
      id: 'user-1',
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha@example.com',
      department: null,
      managerId: 'mgr-7',
    });

    await useCase.execute('user-1', new Date('2026-07-21T13:05:00.000Z'));

    expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
    expect(gateway.emitToUser.mock.calls[0][1]).toMatchObject({
      dayEnded: true,
      current: { status: 'DAY_ENDED' },
    });

    expect(gateway.emitToManager).toHaveBeenCalledTimes(1);
    expect(gateway.emitToManager.mock.calls[0][0]).toBe('mgr-7');
    expect(gateway.emitToManager.mock.calls[0][1]).toMatchObject({ status: 'DAY_ENDED' });
  });

  it('is idempotent: a second press keeps the original end time and fires nothing', async () => {
    const firstEnd = new Date('2026-07-21T18:10:00.000Z');
    const secondPress = new Date('2026-07-21T18:45:00.000Z');
    const date = localDateString(secondPress);
    workDays.markEnded.mockResolvedValue({
      record: { userId: 'user-1', date, endedAt: firstEnd },
      created: false,
    });

    const result = await useCase.execute('user-1', secondPress);

    expect(result.endedAt).toBe(firstEnd.toISOString());
    expect(result.endedAt).not.toBe(secondPress.toISOString());
    // Nothing may re-run: the totals were frozen by the first press.
    expect(samples.stampDuration).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
    expect(gateway.emitToUser).not.toHaveBeenCalled();
  });
});
