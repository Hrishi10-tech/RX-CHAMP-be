// Unit tests for recovering the time a locked, sleeping workstation never reported.
//
// The case these pin down, taken from real data: a user locks her PC at 16:48, the
// machine sleeps five minutes later, and reporting resumes at 17:39 when she comes
// back. One sample can only carry MAX_GAP_SEC, so 46 minutes she genuinely spent away
// used to land as 2m30s of idle and 43 lost minutes that appeared in no column at all.
import { ActivitySampleRecord } from '../domain/activity-sample.repository';
import { LOCK_GAP_FILL_CAP_SEC, LOCK_SCREEN_APP, MAX_GAP_SEC } from './activity.constants';
import { localDateString } from './activity-date.util';
import { fillLockedGaps, isLockedSample } from './locked-time.util';

function sample(at: Date, over: Partial<ActivitySampleRecord> = {}): ActivitySampleRecord {
  return {
    id: `s-${at.toISOString()}`,
    userId: 'user-1',
    deviceId: null,
    date: localDateString(at),
    at,
    durationSec: 60,
    idle: false,
    locked: false,
    app: 'Google Chrome',
    title: null,
    url: null,
    ...over,
  };
}

/** A sample taken on the lock screen, as the agents in the field actually send it. */
function lockScreen(at: Date, durationSec = MAX_GAP_SEC): ActivitySampleRecord {
  return sample(at, { app: LOCK_SCREEN_APP, idle: true, durationSec });
}

/** Local time, deliberately: days and hour buckets are the server's local ones. */
const at = (hhmm: string) => new Date(`2026-09-08T${hhmm}:00`);
const total = (filled: { idleSec: number }[]) => filled.reduce((sum, f) => sum + f.idleSec, 0);

describe('isLockedSample', () => {
  it('trusts the agent flag', () => {
    expect(isLockedSample({ locked: true, app: 'Google Chrome' })).toBe(true);
  });

  it('accepts the lock screen by name, since the flag rarely arrives', () => {
    expect(isLockedSample({ locked: false, app: LOCK_SCREEN_APP })).toBe(true);
  });

  it('is false for ordinary work', () => {
    expect(isLockedSample({ locked: false, app: 'Google Chrome' })).toBe(false);
    expect(isLockedSample({ locked: false, app: null })).toBe(false);
  });
});

describe('fillLockedGaps', () => {
  it('recovers a break taken on a locked machine, less what was already credited', () => {
    // Locked at 16:53 carrying its 150s cap, back at 17:39 — 46m apart.
    const filled = fillLockedGaps([lockScreen(at('16:53')), sample(at('17:39'))]);

    // 46m of hole, 2m30s of it already on the opening sample.
    expect(total(filled)).toBe(46 * 60 - MAX_GAP_SEC);
  });

  it('splits the recovered time across the hours it spans', () => {
    const filled = fillLockedGaps([lockScreen(at('16:53')), sample(at('17:39'))]);

    // The hole runs 16:55:30 → 17:39, so hour 16 takes 4m30s and hour 17 the rest.
    expect(filled).toEqual([
      { hour: 16, idleSec: 4 * 60 + 30 },
      { hour: 17, idleSec: 39 * 60 },
    ]);
  });

  it('ignores ordinary sampling intervals', () => {
    const filled = fillLockedGaps([lockScreen(at('10:00')), lockScreen(at('10:01'))]);

    expect(filled).toEqual([]);
  });

  it('leaves a hole alone when the machine was not locked going into it', () => {
    // Reporting simply stopped — killed agent, network, a pulled plug. Nothing
    // observed the time, so nothing may be claimed about it.
    const filled = fillLockedGaps([sample(at('13:00')), sample(at('13:40'))]);

    expect(filled).toEqual([]);
  });

  it('does not care whether the closing sample is still locked', () => {
    // She unlocks and works before the first new sample lands, which is the common
    // case; the opening sample is what proves nobody was there during the hole.
    const filled = fillLockedGaps([lockScreen(at('11:56')), sample(at('12:24'))]);

    expect(total(filled)).toBe(28 * 60 - MAX_GAP_SEC);
  });

  it('refuses a hole longer than the cap', () => {
    // Past this, "locked at her desk" and "locked it and went home" are the same
    // picture, so the honest answer is to leave the time unaccounted.
    const over = LOCK_GAP_FILL_CAP_SEC + 60;
    const filled = fillLockedGaps([
      lockScreen(at('16:00')),
      sample(new Date(at('16:00').getTime() + over * 1000)),
    ]);

    expect(filled).toEqual([]);
  });

  it('fills a hole exactly at the cap', () => {
    const filled = fillLockedGaps([
      lockScreen(at('16:00')),
      sample(new Date(at('16:00').getTime() + LOCK_GAP_FILL_CAP_SEC * 1000)),
    ]);

    expect(total(filled)).toBe(LOCK_GAP_FILL_CAP_SEC - MAX_GAP_SEC);
  });

  it('never fills a trailing hole — this is what keeps the night out', () => {
    // A machine left locked at 18:00 has no sample after it, so there is nothing to
    // bound the hole and the night is never credited.
    const filled = fillLockedGaps([sample(at('17:00')), lockScreen(at('18:00'))]);

    expect(filled).toEqual([]);
  });

  it('credits only the seconds beyond what the opening sample carried', () => {
    // One second past the sampling window: the opening sample's 150s covers all but
    // that. A stored duration can never exceed MAX_GAP_SEC — the writer clamps it —
    // so this is the smallest hole there is.
    const filled = fillLockedGaps([
      lockScreen(at('10:00')),
      sample(new Date(at('10:00').getTime() + (MAX_GAP_SEC + 1) * 1000)),
    ]);

    expect(total(filled)).toBe(1);
  });

  it('handles a day with no samples', () => {
    expect(fillLockedGaps([])).toEqual([]);
    expect(fillLockedGaps([lockScreen(at('10:00'))])).toEqual([]);
  });
});
