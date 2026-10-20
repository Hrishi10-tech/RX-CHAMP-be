import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The time a request acts at (docs/4.0/SPEC.md 4 and 6). A live request acts at the
 * server's now. An agent event replayed after being offline acts at the moment the
 * person pressed the button (X-Event-At), so windows, order and overlaps are checked
 * as they were then. Every workday, break, meeting and away path reads time here.
 */
export interface ClockFrame {
  /** The replayed event's time, when this request is a replay. */
  eventAt?: Date;
  clientEventId?: string;
}

const storage = new AsyncLocalStorage<ClockFrame>();

export const RequestClock = {
  /** The time this request acts at. */
  now(): Date {
    const at = storage.getStore()?.eventAt;
    return at ? new Date(at.getTime()) : new Date();
  },

  /** True while handling an offline replay. */
  isReplay(): boolean {
    return !!storage.getStore()?.eventAt;
  },

  frame(): ClockFrame | undefined {
    return storage.getStore();
  },

  /** Runs `fn` with `frame` as the request's clock. */
  run<T>(frame: ClockFrame, fn: () => T): T {
    return storage.run(frame, fn);
  },
};
