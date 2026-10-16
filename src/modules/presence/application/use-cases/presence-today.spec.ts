import { GetCurrentPresenceUseCase } from './get-current-presence.use-case';
import { GetMyTodayUseCase } from './get-my-today.use-case';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

function setup(state: { open: boolean; startedToday: boolean; today: string } | undefined) {
  const sessions = {
    findOpenForUser: jest.fn().mockResolvedValue(null),
    listForUserByDate: jest.fn().mockResolvedValue([]),
  };
  const dayEnds = { findEnd: jest.fn().mockResolvedValue(null) };
  const team = { findReports: jest.fn().mockResolvedValue([]) };
  const states = {
    statesFor: jest.fn(async (ids: string[]) => new Map(state ? [[ids[0], state]] : [])),
  };
  const online = { sumSecondsForUserByDate: jest.fn().mockResolvedValue(0) };
  const current = new GetCurrentPresenceUseCase(
    sessions as never,
    dayEnds as never,
    team as never,
    states as never,
  );
  const today = new GetMyTodayUseCase(
    sessions as never,
    online as never,
    dayEnds as never,
    current,
  );
  return { current, today, dayEnds };
}

describe("today's presence status", () => {
  it('/presence/me/today says what /presence/me/current says: NOT_STARTED before Start Day', async () => {
    const { current, today } = setup({ open: false, startedToday: false, today: '2026-10-14' });
    const now = await current.execute('u1');
    const mine = await today.execute('u1');
    expect(now.status).toBe('NOT_STARTED');
    expect(mine.current).toEqual(now);
  });

  it('a working day already started (resumed later) is not NOT_STARTED in either', async () => {
    const { current, today } = setup({ open: false, startedToday: true, today: '2026-10-14' });
    const mine = await today.execute('u1');
    expect(mine.current.status).not.toBe('NOT_STARTED');
    expect(mine.current).toEqual(await current.execute('u1'));
  });

  it("a night shift's early hours read the end mark of the evening's working day", async () => {
    const { current, dayEnds } = setup({ open: true, startedToday: true, today: '2026-10-13' });
    await current.execute('u1');
    expect(dayEnds.findEnd).toHaveBeenCalledWith('u1', '2026-10-13');
  });
});
