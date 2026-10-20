import { RequestClock } from '@shared/tenancy';
import { pendingClock } from './prisma-break-record.repository';

/**
 * Re-audit L2: an item created by a replayed agent action keeps its own times,
 * but the approval SLA runs from when the server received it.
 */
describe('pendingClock', () => {
  const RECEIVED = new Date('2026-10-20T10:00:00.000Z');

  beforeEach(() =>
    jest.useFakeTimers({
      now: RECEIVED,
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    }),
  );
  afterEach(() => jest.useRealTimers());

  it('a live action: the clock starts at its time', () => {
    const at = new Date('2026-10-20T09:59:00.000Z');
    expect(pendingClock(at, 48)).toEqual({
      dueAt: new Date(at.getTime() + 48 * 3_600_000),
      escalatedAt: null,
      remindedAt: null,
    });
  });

  it('a replayed action from three days ago: the clock starts on receipt, not at the event', () => {
    const eventAt = new Date('2026-10-17T05:30:00.000Z');
    const clock = RequestClock.run({ eventAt, clientEventId: 'e1' }, () =>
      pendingClock(RequestClock.now(), 48),
    );
    expect(clock.dueAt).toEqual(new Date(RECEIVED.getTime() + 48 * 3_600_000));
  });
});
