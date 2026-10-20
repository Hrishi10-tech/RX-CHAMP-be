// Unit test for StartDayUseCase — reverses "End Day" for today so the agent can
// resume, and announces the now-live state only when something actually changed.
import { localDateString } from '../activity-date.util';
import { StartDayUseCase } from './start-day.use-case';

describe('StartDayUseCase', () => {
  const workDays = {
    findEnd: jest.fn(),
    findEndsForUsers: jest.fn(),
    markEnded: jest.fn(),
    clearEnd: jest.fn(),
  } as any;
  const samples = {
    findLatestForUser: jest.fn(),
    listForUserByDate: jest.fn(),
    stampDuration: jest.fn(),
  } as any;
  const access = { findSelf: jest.fn(), findReports: jest.fn(), findManagerId: jest.fn() } as any;
  const meetings = { listForUserByDate: jest.fn() } as any;
  const gateway = { emitToUser: jest.fn(), emitForSubject: jest.fn().mockResolvedValue(undefined) } as any;

  let useCase: StartDayUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new StartDayUseCase(workDays, samples, access, meetings, gateway);
    samples.findLatestForUser.mockResolvedValue(null);
    samples.listForUserByDate.mockResolvedValue([]);
    meetings.listForUserByDate.mockResolvedValue([]);
    access.findSelf.mockResolvedValue(undefined);
  });

  it('clears the end mark for the local day derived from the timestamp', async () => {
    const at = new Date('2026-07-21T15:00:00.000Z');
    workDays.clearEnd.mockResolvedValue(true);

    const result = await useCase.execute('user-1', at);

    expect(workDays.clearEnd).toHaveBeenCalledWith('user-1', localDateString(at));
    expect(result).toEqual({ ok: true, date: localDateString(at), resumed: true });
  });

  it("pushes the now-live (not ended) state to the user and to whoever oversees them (4.0 organisation and department rooms)", async () => {
    workDays.clearEnd.mockResolvedValue(true);
    access.findSelf.mockResolvedValue({
      id: 'user-1',
      firstName: 'Asha',
      lastName: 'Rao',
      email: 'asha@example.com',
      department: null,
      managerId: 'mgr-7',
    });

    await useCase.execute('user-1', new Date('2026-07-21T15:00:00.000Z'));

    expect(gateway.emitToUser).toHaveBeenCalledTimes(1);
    expect(gateway.emitToUser.mock.calls[0][1]).toMatchObject({ dayEnded: false });
    expect(gateway.emitForSubject).toHaveBeenCalledTimes(1);
    expect(gateway.emitForSubject.mock.calls[0][0]).toBe('user-1');
    expect(gateway.emitForSubject.mock.calls[0][1]).toMatchObject({ userId: 'user-1' });
  });

  it('a broadcast failure never fails Start Day', async () => {
    workDays.clearEnd.mockResolvedValue(true);
    access.findSelf.mockResolvedValue({ id: 'user-1', firstName: 'Asha', lastName: 'Rao', email: 'a@x', department: null });
    gateway.emitForSubject.mockRejectedValueOnce(new Error('socket down'));
    await expect(useCase.execute('user-1', new Date('2026-07-21T15:00:00.000Z'))).resolves.toMatchObject({ resumed: true });
  });

  it('does nothing (no broadcast) when the day was already open', async () => {
    workDays.clearEnd.mockResolvedValue(false);

    const result = await useCase.execute('user-1', new Date('2026-07-21T15:00:00.000Z'));

    expect(result.resumed).toBe(false);
    expect(gateway.emitToUser).not.toHaveBeenCalled();
    expect(gateway.emitForSubject).not.toHaveBeenCalled();
  });
});
