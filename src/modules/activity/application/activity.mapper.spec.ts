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

    const daily = ActivityMapper.computeDaily(
      samples,
      day,
      DEFAULT_WORKING_BASIS_SEC,
      now,
      endedAt,
    );

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

// Sitting in a meeting is working time even with the keyboard untouched, so those
// minutes count as active. Breaks and lunches are time away and stay idle.
describe('ActivityMapper.computeDaily — meetings count as active', () => {
  const base = new Date('2026-07-16T09:00:00.000Z');
  const day = localDateString(base);
  const now = new Date('2026-07-17T09:00:00.000Z');

  const at = (minute: number) => new Date(base.getTime() + minute * 60_000);

  /** `flags[i]` is the idle flag of the i-th minute-long sample. */
  const run = (flags: boolean[], meetings: { start: Date; end: Date | null }[] = []) =>
    ActivityMapper.computeDaily(
      flags.map((idle, i) => sample(at(i), idle)),
      day,
      DEFAULT_WORKING_BASIS_SEC,
      now,
      null,
      meetings,
    );

  it('counts idle-flagged minutes inside a meeting as active', () => {
    // Nobody typed for the whole 10 minutes, but it was a meeting.
    const daily = run(Array<boolean>(10).fill(true), [{ start: at(0), end: at(10) }]);

    expect(daily.activeSec).toBe(600);
    expect(daily.idleSec).toBe(0);
  });

  it('leaves idle time outside the meeting alone', () => {
    // 5 minutes of meeting, then 5 minutes of genuine inactivity.
    const daily = run(Array<boolean>(10).fill(true), [{ start: at(0), end: at(5) }]);

    expect(daily.activeSec).toBe(300);
    expect(daily.idleSec).toBe(300);
  });

  it('never reclassifies meeting time into idle', () => {
    // Meeting, then a normal idle drift: the backfill must not eat the meeting.
    const daily = run([true, true, true, true, true, true, true], [{ start: at(0), end: at(5) }]);

    expect(daily.activeSec).toBe(300); // the 5 meeting minutes survive
    expect(daily.idleSec).toBe(120);
  });

  it('ignores a meeting left open on a past day', () => {
    // A session the user never ended. Trusting it would turn the rest of the day into
    // meeting time, so on a finished day it is treated as missing data.
    const daily = run(Array<boolean>(4).fill(true), [{ start: at(0), end: null }]);

    expect(daily.activeSec).toBe(0);
    expect(daily.idleSec).toBe(240);
  });

  it('treats a meeting still running today as ongoing', () => {
    const today = new Date();
    const start = new Date(today.getTime() - 10 * 60_000);
    const samples = [0, 1, 2].map(
      (i) => sample(new Date(start.getTime() + i * 60_000), true), // idle-flagged
    );

    const daily = ActivityMapper.computeDaily(
      samples,
      localDateString(today),
      DEFAULT_WORKING_BASIS_SEC,
      today,
      null,
      [{ start, end: null }],
    );

    expect(daily.activeSec).toBeGreaterThan(0);
    expect(daily.idleSec).toBe(0);
  });

  it('keeps break and lunch idle — no windows are passed for them', () => {
    // Same shape as a meeting, but with no window: stays idle.
    const daily = run(Array<boolean>(10).fill(true));

    expect(daily.activeSec).toBe(0);
    expect(daily.idleSec).toBe(600);
  });
});

// Ending the day freezes it: the trailing open sample stops accruing at the End
// Day instant instead of tracking the wall clock, so the totals never drift after
// the user has been told their hours are final.
describe('ActivityMapper.computeDaily — ending the day freezes the totals', () => {
  const day = '2026-07-16';
  const at = new Date('2026-07-16T17:00:00.000Z');
  const endedAt = new Date('2026-07-16T17:00:30.000Z'); // 30s into the open sample

  /** One still-open sample (durationSec = 0), as the agent leaves its last one. */
  const open: ActivitySampleRecord = { ...sample(at), durationSec: 0 };

  function activeSecAt(now: Date, ended: Date | null): number {
    return ActivityMapper.computeDaily([open], day, DEFAULT_WORKING_BASIS_SEC, now, ended)
      .activeSec;
  }

  it('stops the open sample at the End Day instant, not at "now"', () => {
    // Two minutes after the press, the open sample must still be worth 30s.
    expect(activeSecAt(new Date('2026-07-16T17:02:00.000Z'), endedAt)).toBe(30);
  });

  it('does not drift as time passes after the day ended', () => {
    const soon = activeSecAt(new Date('2026-07-16T17:01:00.000Z'), endedAt);
    const later = activeSecAt(new Date('2026-07-16T17:20:00.000Z'), endedAt);

    expect(later).toBe(soon);
  });

  it('still counts up to "now" while the day is open', () => {
    // Same sample, no End Day: it keeps growing (capped by MAX_GAP_SEC).
    expect(activeSecAt(new Date('2026-07-16T17:01:00.000Z'), null)).toBe(60);
  });

  it('reports dayEnded so the agent can tell on a fresh launch', () => {
    const open = ActivityMapper.computeDaily([], day, DEFAULT_WORKING_BASIS_SEC, at, null);
    const ended = ActivityMapper.computeDaily([], day, DEFAULT_WORKING_BASIS_SEC, at, endedAt);

    expect(open.dayEnded).toBe(false);
    expect(ended.dayEnded).toBe(true);
  });
});

describe('ActivityMapper.statusOf — DAY_ENDED', () => {
  const now = new Date('2026-07-16T17:01:00.000Z');
  const recent = sample(new Date('2026-07-16T17:00:30.000Z'));

  it('outranks a live sample once the day has ended', () => {
    expect(ActivityMapper.statusOf(recent, now)).toBe('ACTIVE');
    expect(ActivityMapper.statusOf(recent, now, true)).toBe('DAY_ENDED');
  });

  it('is reported instead of OFFLINE when no sample exists', () => {
    expect(ActivityMapper.statusOf(null, now)).toBe('OFFLINE');
    expect(ActivityMapper.statusOf(null, now, true)).toBe('DAY_ENDED');
  });

  it('clears the foreground app on the team board', () => {
    const member = { id: 'u1', firstName: 'A', lastName: 'B', email: 'a@b.c', department: null };
    const view = ActivityMapper.toTeamMemberView(member, recent, now, true);

    expect(view.status).toBe('DAY_ENDED');
    expect(view.app).toBeNull();
  });
});
