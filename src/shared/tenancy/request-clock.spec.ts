import { RequestClock } from './request-clock';

describe('RequestClock', () => {
  afterEach(() => jest.useRealTimers());

  it('is the server time outside any frame', () => {
    jest.useFakeTimers({ now: new Date('2026-10-20T06:00:00.000Z') });
    expect(RequestClock.now().toISOString()).toBe('2026-10-20T06:00:00.000Z');
    expect(RequestClock.isReplay()).toBe(false);
    expect(RequestClock.frame()).toBeUndefined();
  });

  it('is the server time inside a live frame (no event time)', () => {
    jest.useFakeTimers({ now: new Date('2026-10-20T06:00:00.000Z') });
    RequestClock.run({ clientEventId: 'e-1' }, () => {
      expect(RequestClock.now().toISOString()).toBe('2026-10-20T06:00:00.000Z');
      expect(RequestClock.isReplay()).toBe(false);
      expect(RequestClock.frame()).toEqual({ clientEventId: 'e-1' });
    });
  });

  it('is the event time while a replay runs, and stays fixed as the server clock moves', () => {
    jest.useFakeTimers({ now: new Date('2026-10-20T06:00:00.000Z') });
    const eventAt = new Date('2026-10-20T03:15:00.000Z');
    RequestClock.run({ eventAt, clientEventId: 'e-2' }, () => {
      expect(RequestClock.now().toISOString()).toBe('2026-10-20T03:15:00.000Z');
      jest.advanceTimersByTime(60_000);
      expect(RequestClock.now().toISOString()).toBe('2026-10-20T03:15:00.000Z');
      expect(RequestClock.isReplay()).toBe(true);
      expect(RequestClock.frame()?.clientEventId).toBe('e-2');
    });
    // Back outside: the server clock again.
    expect(RequestClock.now().toISOString()).toBe('2026-10-20T06:01:00.000Z');
  });

  it('hands out a copy, so a caller cannot move the frame time', () => {
    const eventAt = new Date('2026-10-20T03:15:00.000Z');
    RequestClock.run({ eventAt }, () => {
      const a = RequestClock.now();
      a.setUTCHours(0);
      expect(RequestClock.now().toISOString()).toBe('2026-10-20T03:15:00.000Z');
      expect(RequestClock.now()).not.toBe(eventAt);
    });
  });

  it('follows the request across awaits and keeps concurrent requests apart', async () => {
    const seen: Record<string, string[]> = { a: [], b: [] };
    const handler = async (name: 'a' | 'b') => {
      seen[name].push(RequestClock.now().toISOString());
      await new Promise((r) => setTimeout(r, 5));
      seen[name].push(RequestClock.now().toISOString());
      await Promise.resolve();
      seen[name].push(RequestClock.isReplay() ? 'replay' : 'live');
    };
    await Promise.all([
      RequestClock.run({ eventAt: new Date('2026-10-19T09:00:00.000Z') }, () => handler('a')),
      RequestClock.run({ eventAt: new Date('2026-10-18T10:30:00.000Z') }, () => handler('b')),
    ]);
    expect(seen.a).toEqual(['2026-10-19T09:00:00.000Z', '2026-10-19T09:00:00.000Z', 'replay']);
    expect(seen.b).toEqual(['2026-10-18T10:30:00.000Z', '2026-10-18T10:30:00.000Z', 'replay']);
  });

  it('returns what the function returns and nests frames', () => {
    const outer = new Date('2026-10-19T09:00:00.000Z');
    const inner = new Date('2026-10-19T09:30:00.000Z');
    const out = RequestClock.run({ eventAt: outer }, () => {
      const nested = RequestClock.run({ eventAt: inner }, () => RequestClock.now().toISOString());
      return [nested, RequestClock.now().toISOString()];
    });
    expect(out).toEqual(['2026-10-19T09:30:00.000Z', '2026-10-19T09:00:00.000Z']);
  });
});
