import { ConflictError } from '@shared/exceptions/app.exception';
import { EndPresenceUseCase } from './end-presence.use-case';
import { StartPresenceUseCase } from './start-presence.use-case';

/**
 * Re-audit M3: /presence/start and /presence/end are replayed agent actions, so
 * they run on the request's clock (a replay's own time), date the status on the
 * open working day, and need that day open like every other agent action.
 */
const EVENT = new Date('2026-10-17T05:30:00.000Z'); // 11:00 IST, three days ago

function setup() {
  const sessions = {
    switchTo: jest.fn(async (data: { date: string }, now: Date) => ({
      closed: null,
      opened: {
        id: 'p1',
        userId: 'u1',
        type: 'BREAK',
        note: null,
        date: data.date,
        startedAt: now,
        endedAt: null,
      },
    })),
    endOpenForUser: jest.fn().mockResolvedValue(null),
  };
  const team = { findContext: jest.fn().mockResolvedValue(null) };
  const dayEnds = { findEnd: jest.fn().mockResolvedValue(null) };
  const events = { publish: jest.fn(), subscribe: jest.fn() };
  const gateway = { emitForSubject: jest.fn() };
  const day = {
    ensureOpen: jest.fn().mockResolvedValue({
      date: '2026-10-17',
      startedAt: new Date('2026-10-17T03:30:00.000Z'),
    }),
  };
  const start = new StartPresenceUseCase(
    sessions as never,
    team as never,
    dayEnds as never,
    events as never,
    gateway as never,
    day as never,
  );
  const end = new EndPresenceUseCase(
    sessions as never,
    team as never,
    gateway as never,
    day as never,
  );
  return { start, end, sessions, day, dayEnds, events };
}

describe('presence start and end on the request clock (re-audit M3)', () => {
  it('a replayed break starts at its own time, on its working day, inside an open day', async () => {
    const { start, sessions, day, events } = setup();
    await start.execute('u1', { type: 'BREAK' }, 'AGENT_31', EVENT);
    expect(day.ensureOpen).toHaveBeenCalledWith('u1', 'AGENT_31', EVENT);
    expect(sessions.switchTo).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-10-17', type: 'BREAK' }),
      EVENT,
    );
    expect(events.publish.mock.calls[0][1]).toMatchObject({ at: EVENT });
  });

  it('a closed day refuses it (409) before anything is written', async () => {
    const { start, end, sessions, day } = setup();
    day.ensureOpen.mockRejectedValue(new ConflictError('Ended', 'DAY_ENDED'));
    await expect(start.execute('u1', { type: 'BREAK' }, 'AGENT_31', EVENT)).rejects.toMatchObject({
      code: 'DAY_ENDED',
    });
    await expect(end.execute('u1', 'AGENT_31', EVENT)).rejects.toMatchObject({ code: 'DAY_ENDED' });
    expect(sessions.switchTo).not.toHaveBeenCalled();
    expect(sessions.endOpenForUser).not.toHaveBeenCalled();
  });

  it('a replayed end closes at its own time', async () => {
    const { end, sessions } = setup();
    await end.execute('u1', 'AGENT_31', EVENT);
    expect(sessions.endOpenForUser).toHaveBeenCalledWith('u1', EVENT);
  });

  it('older agents keep the 3.0 rule: no open session needed, refused after End Day', async () => {
    const { start, end, day, dayEnds, sessions } = setup();
    await start.execute('u1', { type: 'MEETING' }, 'LEGACY', EVENT);
    await end.execute('u1', 'LEGACY', EVENT);
    expect(day.ensureOpen).not.toHaveBeenCalled();
    expect(sessions.switchTo.mock.calls[0][0]).toMatchObject({ date: '2026-10-17' });
    dayEnds.findEnd.mockResolvedValue({ endedAt: EVENT });
    await expect(start.execute('u1', { type: 'BREAK' }, 'LEGACY', EVENT)).rejects.toMatchObject({
      status: 409,
    });
  });
});
