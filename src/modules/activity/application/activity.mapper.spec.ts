// Unit test for ActivityMapper.computeDaily's clock-out resolution: when the
// user has ended their day, `clockOutAt` is the End Day timestamp; otherwise it
// falls back to the last sample (and is null when there are no samples).
import { ActivitySampleRecord } from '../domain/activity-sample.repository';
import { ActivityMapper } from './activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC } from './activity.constants';
import { localDateString } from './activity-date.util';

function sample(at: Date, idle = false, locked = false): ActivitySampleRecord {
  return {
    id: `s-${at.toISOString()}`,
    userId: 'user-1',
    deviceId: null,
    date: localDateString(at),
    at,
    durationSec: 60,
    idle,
    locked,
    app: 'Google Chrome',
    title: null,
    url: null,
  };
}

describe('ActivityMapper.computeDaily — clockOutAt', () => {
  const now = new Date('2026-07-16T18:30:00.000Z');
  const day = localDateString(now);
  const samples = [
    sample(new Date('2026-07-16T09:00:00.000Z')),
    sample(new Date('2026-07-16T17:00:00.000Z')),
  ];

  it('uses the End Day timestamp when the day was ended', () => {
    const endedAt = new Date('2026-07-16T18:10:00.000Z');

    const daily = ActivityMapper.computeDaily(samples, day, DEFAULT_WORKING_BASIS_SEC, now, endedAt);

    expect(daily.clockOutAt).toBe(endedAt.toISOString());
  });

  it('falls back to the last sample when the day was not ended', () => {
    const daily = ActivityMapper.computeDaily(samples, day, DEFAULT_WORKING_BASIS_SEC, now, null);

    expect(daily.clockOutAt).toBe(samples[samples.length - 1].at.toISOString());
  });

  it('is null when there are no samples and no End Day', () => {
    const daily = ActivityMapper.computeDaily([], day, DEFAULT_WORKING_BASIS_SEC, now, null);

    expect(daily.clockOutAt).toBeNull();
    expect(daily.clockInAt).toBeNull();
  });
});

// The agent only flags a sample idle after IDLE_THRESHOLD_SEC of no input, so the
// lead-in was recorded as active despite nobody being there. computeDaily moves it.
describe('ActivityMapper.computeDaily — idle grace backfill', () => {
  const base = new Date('2026-07-16T09:00:00.000Z');
  const day = localDateString(base);
  // A day already finished, so nothing counts "live" and totals are exact.
  const now = new Date('2026-07-17T09:00:00.000Z');

  /** `flags[i]` is the idle flag of the i-th minute-long sample. */
  const run = (flags: boolean[]) =>
    ActivityMapper.computeDaily(
      flags.map((idle, i) => sample(new Date(base.getTime() + i * 60_000), idle)),
      day,
      DEFAULT_WORKING_BASIS_SEC,
      now,
    );

  it('counts a 7-minute walk-away entirely as idle', () => {
    // 5 minutes before the flag turns on, then 2 flagged minutes.
    const daily = run([false, false, false, false, false, true, true]);

    expect(daily.activeSec).toBe(0);
    expect(daily.idleSec).toBe(420);
  });

  it('keeps genuine work and only reclassifies the threshold before going idle', () => {
    // 10 active minutes, then 2 flagged idle: real work ends 5 minutes before the flag.
    const daily = run([...Array<boolean>(10).fill(false), true, true]);

    expect(daily.activeSec).toBe(300); // 600 recorded − 300 reclassified
    expect(daily.idleSec).toBe(420); // 120 flagged + 300 reclassified
  });

  it('leaves a day with no idle samples untouched', () => {
    const daily = run([false, false, false]);

    expect(daily.activeSec).toBe(180);
    expect(daily.idleSec).toBe(0);
  });

  it('never reaches back past an earlier idle stretch', () => {
    // Only the single active minute may move — the run before it is already idle.
    const daily = run([true, true, false, true]);

    expect(daily.activeSec).toBe(0);
    expect(daily.idleSec).toBe(240);
  });

  it('invents no time when the agent recorded none', () => {
    // One flagged sample and nothing before it: a full threshold cannot be filled.
    const daily = run([true]);

    expect(daily.activeSec).toBe(0);
    expect(daily.idleSec).toBe(60);
  });

  it('drops reclassified seconds from top apps too', () => {
    const daily = run([false, false, false, false, false, true, true]);

    // Every active second became idle, so the app earned no foreground time.
    expect(daily.topApps).toEqual([]);
  });

  it('keeps the hourly split in step with the totals', () => {
    const daily = run([false, false, false, false, false, true, true]);
    const hourActive = daily.hourly.reduce((sum, h) => sum + h.activeSec, 0);
    const hourIdle = daily.hourly.reduce((sum, h) => sum + h.idleSec, 0);

    expect(hourActive).toBe(daily.activeSec);
    expect(hourIdle).toBe(daily.idleSec);
  });
});

// Win+L is unambiguous and instantaneous, so it counts as idle from that moment —
// and, unlike a slow drift into inactivity, has no lead-in to reclassify.
describe('ActivityMapper.computeDaily — locked workstation', () => {
  const base = new Date('2026-07-16T09:00:00.000Z');
  const day = localDateString(base);
  const now = new Date('2026-07-17T09:00:00.000Z');

  /** Each entry is one minute-long sample: 'work' | 'idle' | 'lock'. */
  const run = (kinds: Array<'work' | 'idle' | 'lock'>) =>
    ActivityMapper.computeDaily(
      kinds.map((k, i) =>
        sample(new Date(base.getTime() + i * 60_000), k !== 'work', k === 'lock'),
      ),
      day,
      DEFAULT_WORKING_BASIS_SEC,
      now,
    );

  it('counts locked time as idle without touching the work before it', () => {
    // 5 minutes of real work, then Win+L for 3 minutes.
    const daily = run(['work', 'work', 'work', 'work', 'work', 'lock', 'lock', 'lock']);

    expect(daily.activeSec).toBe(300); // all 5 working minutes survive
    expect(daily.idleSec).toBe(180); // only the locked minutes
  });

  it('still backfills a normal idle drift, so the two rules coexist', () => {
    // Drift into idle (backfilled), then later a lock (not backfilled).
    const drift = run(['work', 'work', 'idle']);
    const lock = run(['work', 'work', 'lock']);

    expect(drift.activeSec).toBe(0); // both working minutes reclassified
    expect(lock.activeSec).toBe(120); // both working minutes kept
  });

  it('resumes active time after unlocking', () => {
    const daily = run(['work', 'lock', 'lock', 'work', 'work']);

    expect(daily.activeSec).toBe(180); // 1 before + 2 after
    expect(daily.idleSec).toBe(120);
  });

  it('credits no app time to the lock screen', () => {
    const daily = run(['lock', 'lock']);

    expect(daily.topApps).toEqual([]);
    expect(daily.idleSec).toBe(120);
  });
});
