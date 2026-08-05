// Unit test for EndDayUseCase — marks the current local day ended (deriving the
// day from the given timestamp) and is idempotent (a second press keeps the
// original end time returned by the repository).
import { WorkDayEndRecord } from '../../domain/work-day.repository';
import { localDateString } from '../activity-date.util';
import { EndDayUseCase } from './end-day.use-case';

describe('EndDayUseCase', () => {
  const workDays = { findEnd: jest.fn(), markEnded: jest.fn() } as any;

  let useCase: EndDayUseCase;
  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new EndDayUseCase(workDays);
    // By default the repo echoes back what it was asked to persist.
    workDays.markEnded.mockImplementation(
      async (userId: string, date: string, endedAt: Date): Promise<WorkDayEndRecord> => ({
        userId,
        date,
        endedAt,
      }),
    );
  });

  it('marks the day ended using the local day derived from the timestamp', async () => {
    const at = new Date('2026-07-21T13:05:00.000Z');
    const expectedDate = localDateString(at);

    const result = await useCase.execute('user-1', at);

    expect(workDays.markEnded).toHaveBeenCalledTimes(1);
    expect(workDays.markEnded).toHaveBeenCalledWith('user-1', expectedDate, at);
    expect(result).toEqual({
      ok: true,
      date: expectedDate,
      endedAt: at.toISOString(),
    });
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

  it('is idempotent: returns the original end time the repo already holds', async () => {
    const firstEnd = new Date('2026-07-21T18:10:00.000Z');
    const secondPress = new Date('2026-07-21T18:45:00.000Z');
    const date = localDateString(secondPress);
    // Repo ignores the new timestamp and keeps the first one (upsert with no update).
    workDays.markEnded.mockResolvedValue({ userId: 'user-1', date, endedAt: firstEnd });

    const result = await useCase.execute('user-1', secondPress);

    expect(result.endedAt).toBe(firstEnd.toISOString());
    expect(result.endedAt).not.toBe(secondPress.toISOString());
  });
});
