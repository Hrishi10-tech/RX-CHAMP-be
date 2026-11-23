import {
  afterSkipActivity,
  afterSkipWindow,
  breakdownIn,
  InputSample,
  inputIntervals,
  withMeetings,
} from './input-activity';

const T0 = new Date('2026-10-14T05:30:00.000Z'); // 11:00 in India

/** A sample every minute from `fromMin` to `toMin` (exclusive), each standing 60 s. */
function run(fromMin: number, toMin: number, idle = false, locked = false): InputSample[] {
  const out: InputSample[] = [];
  for (let m = fromMin; m < toMin; m++) {
    out.push({
      at: new Date(T0.getTime() + m * 60_000),
      durationSec: 60,
      idle,
      locked,
      app: locked ? 'LockApp.exe' : 'Code.exe',
    });
  }
  return out;
}

const win = (fromMin: number, toMin: number) => ({
  start: T0.getTime() + fromMin * 60_000,
  end: T0.getTime() + toMin * 60_000,
});
const LATER = new Date(T0.getTime() + 6 * 60 * 60_000);

describe('inputIntervals and breakdownIn', () => {
  it('counts steady input as active', () => {
    const b = breakdownIn(inputIntervals(run(0, 30), LATER), [win(0, 30)], LATER);
    expect(b).toEqual({ activeSec: 1800, idleSec: 0, noDataSec: 0, spanSec: 1800 });
  });

  it('moves the five minutes before an idle flag from active to idle', () => {
    // Worked 0-20, walked away at 20: the agent still says "active" until 25, then idle.
    const samples = [...run(0, 25), ...run(25, 40, true)];
    const b = breakdownIn(inputIntervals(samples, LATER), [win(0, 40)], LATER);
    expect(b.activeSec).toBe(20 * 60);
    expect(b.idleSec).toBe(20 * 60);
    expect(b.noDataSec).toBe(0);
  });

  it('gives a lock no lead-in: the person worked right up to it', () => {
    const samples = [...run(0, 25), ...run(25, 40, true, true)];
    const b = breakdownIn(inputIntervals(samples, LATER), [win(0, 40)], LATER);
    expect(b.activeSec).toBe(25 * 60);
    expect(b.idleSec).toBe(15 * 60);
  });

  it('fills the hole a locked, sleeping PC leaves before it reports again', () => {
    // Locked at 10, nothing reported 11-50, back at 50.
    const samples = [...run(0, 10), ...run(10, 11, true, true), ...run(50, 60)];
    const b = breakdownIn(inputIntervals(samples, LATER), [win(0, 60)], LATER);
    expect(b.activeSec).toBe(20 * 60);
    expect(b.idleSec).toBe(40 * 60);
    expect(b.noDataSec).toBe(0);
  });

  it('leaves time with no sample at all as no data, never as active or idle', () => {
    const samples = [...run(0, 10), ...run(40, 50)];
    const b = breakdownIn(inputIntervals(samples, LATER), [win(0, 50)], LATER);
    expect(b.activeSec).toBe(20 * 60);
    expect(b.idleSec).toBe(0);
    expect(b.noDataSec).toBe(30 * 60);
  });

  it('caps one sample at 150 s', () => {
    const s: InputSample[] = [{ at: T0, durationSec: 3600, idle: false, locked: false, app: 'x' }];
    expect(breakdownIn(inputIntervals(s, LATER), [win(0, 60)], LATER).activeSec).toBe(150);
  });

  it('lets the newest open sample stand until now, capped', () => {
    const s: InputSample[] = [{ at: T0, durationSec: 0, idle: false, locked: false, app: 'x' }];
    const now = new Date(T0.getTime() + 90_000);
    expect(breakdownIn(inputIntervals(s, now), [win(0, 60)], now)).toEqual({
      activeSec: 90,
      idleSec: 0,
      noDataSec: 0,
      spanSec: 90,
    });
  });

  it('counts input on one device over idle on another', () => {
    const samples = [...run(0, 10), ...run(0, 10, true)];
    const b = breakdownIn(inputIntervals(samples, LATER), [win(0, 10)], LATER);
    expect(b.activeSec).toBe(10 * 60);
    expect(b.idleSec).toBe(0);
  });

  it('one PC going idle never cuts the input on another PC (each PC has its own idle timer)', () => {
    const a = run(0, 30).map((x) => ({ ...x, deviceId: 'laptop' }));
    // The desktop was left alone at 5: its idle flag comes at 10.
    const b = [...run(0, 10), ...run(10, 30, true)].map((x) => ({ ...x, deviceId: 'desktop' }));
    const b0 = breakdownIn(inputIntervals([...a, ...b], LATER), [win(0, 30)], LATER);
    expect(b0.activeSec).toBe(30 * 60);
    expect(b0.idleSec).toBe(0);
    // Alone, the desktop's lead-in is idle.
    const b1 = breakdownIn(inputIntervals(b, LATER), [win(0, 30)], LATER);
    expect(b1.activeSec).toBe(5 * 60);
    expect(b1.idleSec).toBe(25 * 60);
  });

  it('counts only the part of the windows that has happened', () => {
    const now = new Date(T0.getTime() + 10 * 60_000);
    const b = breakdownIn(inputIntervals(run(0, 10), now), [win(0, 60)], now);
    expect(b.spanSec).toBe(600);
  });
});

describe('afterSkipWindow', () => {
  const skippedAt = new Date(T0.getTime() - 10 * 60_000);
  it('judges a manual skip from the moment it was pressed', () => {
    const w = afterSkipWindow('SKIPPED', skippedAt, T0);
    expect(w).toEqual({
      from: skippedAt,
      to: new Date(skippedAt.getTime() + 15 * 60_000),
      basis: 'SKIPPED_AT',
    });
  });
  it('judges an auto-skip from when the break was due', () => {
    const closedAt = new Date(T0.getTime() + 60 * 60_000);
    const w = afterSkipWindow('AUTO_SKIPPED', closedAt, T0);
    expect(w).toEqual({ from: T0, to: new Date(T0.getTime() + 15 * 60_000), basis: 'BREAK_START' });
  });
});

describe('afterSkipActivity', () => {
  const window = afterSkipWindow('SKIPPED', T0, null);

  it('ACTIVE when they kept working', () => {
    const r = afterSkipActivity(window, run(0, 40), LATER);
    expect(r).toMatchObject({
      verdict: 'ACTIVE',
      activeSec: 900,
      windowMin: 15,
      basis: 'SKIPPED_AT',
    });
  });

  it('NONE when they walked away right after skipping (the lead-in is not work)', () => {
    // Skipped at 0 and left: active-looking samples until the idle flag at 5.
    const r = afterSkipActivity(window, [...run(0, 5), ...run(5, 30, true)], LATER);
    expect(r.verdict).toBe('NONE');
    expect(r.activeSec).toBe(0);
    expect(r.idleSec).toBe(900);
  });

  it('LOW when there was a little input', () => {
    // Two minutes of work, then away (idle flagged at 7).
    const r = afterSkipActivity(window, [...run(0, 7), ...run(7, 30, true)], LATER);
    expect(r.verdict).toBe('LOW');
    expect(r.activeSec).toBe(120);
  });

  it('NO_DATA when the agent reported nothing', () => {
    expect(afterSkipActivity(window, [], LATER).verdict).toBe('NO_DATA');
  });

  it('PENDING until the window and one idle threshold have passed', () => {
    const now = new Date(T0.getTime() + 19 * 60_000);
    expect(afterSkipActivity(window, run(0, 19), now).verdict).toBe('PENDING');
    const settled = new Date(T0.getTime() + 20 * 60_000);
    expect(afterSkipActivity(window, run(0, 20), settled).verdict).toBe('ACTIVE');
  });
});

describe('withMeetings (D-22)', () => {
  const span = (from: number, to: number) => ({ start: from * 1000, end: to * 1000 });

  it('idle inside a meeting is active, and idle outside it stays idle', () => {
    const input = { active: [span(0, 100)], idle: [span(100, 400)] };
    expect(withMeetings(input, [span(100, 300)])).toEqual({
      active: [span(0, 300)],
      idle: [span(300, 400)],
    });
  });

  it('with no meeting nothing changes', () => {
    const input = { active: [span(0, 100)], idle: [span(100, 400)] };
    expect(withMeetings(input, [])).toBe(input);
  });
});

describe('afterSkipActivity with a meeting after the skip (D-22)', () => {
  const from = new Date('2026-11-05T05:00:00Z');
  const to = new Date(from.getTime() + 15 * 60_000);
  const idleSamples = Array.from({ length: 30 }, (_, i) => ({
    at: new Date(from.getTime() + i * 60_000),
    durationSec: 60,
    idle: true,
    locked: false,
    app: null,
  }));
  const now = new Date(from.getTime() + 60 * 60_000);
  const window = { from, to, basis: 'SKIPPED_AT' as const };

  it('nobody at the keyboard and no meeting: no input', () => {
    expect(afterSkipActivity(window, idleSamples, now)).toMatchObject({
      verdict: 'NONE',
      idleSec: 15 * 60,
    });
  });

  it('in a meeting all along: kept working, none of it idle', () => {
    const meeting = { start: from.getTime(), end: to.getTime() + 60_000 };
    expect(afterSkipActivity(window, idleSamples, now, [meeting])).toMatchObject({
      verdict: 'ACTIVE',
      activeSec: 15 * 60,
      idleSec: 0,
    });
  });
});
