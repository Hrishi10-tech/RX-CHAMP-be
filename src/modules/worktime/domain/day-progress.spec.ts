import { computeFocus } from './focus';
import { DayProgressInput, dayProgressOf } from './day-progress';

const at = (hhmm: string) => new Date(`2026-11-05T${hhmm}:00+05:30`);
const H = 3600;
const base: DayProgressInput = {
  date: '2026-11-05',
  state: 'OPEN',
  focusSec: 5 * H + 12 * 60,
  expectedSec: 8 * H,
  hasShift: true,
  open: null,
};

describe('dayProgressOf', () => {
  it('returns exactly the contract, nothing more (4.1 adds remote)', () => {
    expect(Object.keys(dayProgressOf(base)).sort()).toEqual(
      [
        'status',
        'remote',
        'date',
        'workedSec',
        'targetSec',
        'targetFromShift',
        'overSec',
        'breakStartedAt',
        'breakEndsAt',
        'meetingStartedAt',
        'meetingPromptAt',
        'meetingFallbackAt',
      ].sort(),
    );
  });

  it('Not started: an empty ring', () => {
    expect(dayProgressOf({ ...base, state: 'NOT_STARTED', focusSec: 0 })).toEqual({
      status: 'NOT_STARTED',
      remote: false,
      date: '2026-11-05',
      workedSec: 0,
      targetSec: 8 * H,
      targetFromShift: true,
      overSec: 0,
      breakStartedAt: null,
      breakEndsAt: null,
      meetingStartedAt: null,
      meetingPromptAt: null,
      meetingFallbackAt: null,
    });
  });

  it('Remote (4.1): a remote day reads as working remotely, and only while it is open', () => {
    expect(dayProgressOf({ ...base, remote: true })).toMatchObject({ status: 'WORKING', remote: true });
    expect(dayProgressOf(base).remote).toBe(false);
    expect(dayProgressOf({ ...base, state: 'ENDED', remote: true }).remote).toBe(false);
  });

  it('Working: the panel figures as they are', () => {
    expect(dayProgressOf(base)).toMatchObject({
      status: 'WORKING',
      workedSec: 5 * H + 12 * 60,
      targetSec: 8 * H,
      overSec: 0,
    });
  });

  it('In a meeting: when it started, when the question comes and when it falls back', () => {
    const v = dayProgressOf({
      ...base,
      open: { type: 'MEETING', startedAt: at('10:00') },
      meetingConfirmedAt: at('11:00'),
    });
    expect(v).toMatchObject({
      status: 'MEETING',
      meetingStartedAt: at('10:00').toISOString(),
      meetingPromptAt: at('13:00').toISOString(),
      meetingFallbackAt: at('13:10').toISOString(),
      breakStartedAt: null,
      breakEndsAt: null,
    });
  });

  it('a declared meeting is a meeting with no question', () => {
    const v = dayProgressOf({ ...base, open: { type: 'MEETING', startedAt: at('10:00') } });
    expect(v).toMatchObject({ status: 'MEETING', meetingPromptAt: null, meetingFallbackAt: null });
  });

  it('On a break, or lunch: when it started and when it ends', () => {
    const v = dayProgressOf({
      ...base,
      open: { type: 'LUNCH', startedAt: at('13:00') },
      breakDurationMin: 45,
    });
    expect(v).toMatchObject({
      status: 'BREAK',
      breakStartedAt: at('13:00').toISOString(),
      breakEndsAt: at('13:45').toISOString(),
      meetingStartedAt: null,
    });
    expect(
      dayProgressOf({ ...base, open: { type: 'BREAK', startedAt: at('13:00') } }).breakEndsAt,
    ).toBeNull();
  });

  it('Target reached: the extra time', () => {
    expect(dayProgressOf({ ...base, focusSec: 8 * H + 15 * 60 })).toMatchObject({
      workedSec: 8 * H + 15 * 60,
      overSec: 15 * 60,
    });
    expect(dayProgressOf({ ...base, focusSec: 8 * H }).overSec).toBe(0);
  });

  it('Day ended: keeps the total; an old open presence never shows', () => {
    expect(
      dayProgressOf({
        ...base,
        state: 'ENDED',
        focusSec: 8 * H,
        open: { type: 'BREAK', startedAt: at('13:00') },
      }),
    ).toMatchObject({ status: 'ENDED', workedSec: 8 * H, breakStartedAt: null });
  });

  it('no target from a shift: 8 hours, and it says so', () => {
    const noShift = { targetSec: 8 * H, targetFromShift: false };
    expect(dayProgressOf({ ...base, expectedSec: 0 })).toMatchObject(noShift);
    expect(dayProgressOf({ ...base, expectedSec: 8 * H, hasShift: false })).toMatchObject(noShift);
    expect(dayProgressOf({ ...base, expectedSec: 0, hasShift: false })).toMatchObject(noShift);
    expect(dayProgressOf({ ...base, expectedSec: 4 * H })).toMatchObject({
      targetSec: 4 * H,
      targetFromShift: true,
    });
  });

  it('no shift with part of the day on leave: what the panel expects, so the two agree', () => {
    // 8 hours less a half day of leave is what the panel, Team today and the day class use.
    expect(dayProgressOf({ ...base, expectedSec: 4 * H, hasShift: false })).toMatchObject({
      targetSec: 4 * H,
      targetFromShift: false,
    });
  });

  it('reproduces design page 4: the ring against an 8 hour target', () => {
    // 09:30 Start day, a meeting 11:30 to 12:30, a break 13:00 to 13:45, target at 18:15.
    const focusAt = (now: Date, ended: boolean) =>
      computeFocus({
        sessions: [{ startedAt: at('09:30'), endedAt: ended ? now : null }],
        presence: (
          [
            { type: 'MEETING', startedAt: at('11:30'), endedAt: at('12:30') },
            { type: 'BREAK', startedAt: at('13:00'), endedAt: at('13:45') },
          ] as const
        )
          .filter((p) => p.startedAt < now)
          .map((p) => ({ ...p })),
        breakRecords: [],
        meetingRecords: [],
        now,
      }).focusSec;
    const pct = (s: number) => Math.round((s / (8 * H)) * 100);
    expect(focusAt(at('11:30'), false)).toBe(2 * H);
    expect(pct(focusAt(at('11:30'), false))).toBe(25);
    expect(focusAt(at('13:00'), false)).toBe(3 * H + 30 * 60);
    expect(focusAt(at('13:45'), false)).toBe(3 * H + 30 * 60);
    expect(pct(focusAt(at('13:45'), false))).toBe(44);
    expect(focusAt(at('16:00'), false)).toBe(5 * H + 45 * 60);
    expect(pct(focusAt(at('16:00'), false))).toBe(72);
    expect(focusAt(at('18:15'), false)).toBe(8 * H);
    expect(pct(focusAt(at('18:15'), false))).toBe(100);
    expect(focusAt(at('18:30'), true)).toBe(8 * H + 15 * 60);
  });
});
