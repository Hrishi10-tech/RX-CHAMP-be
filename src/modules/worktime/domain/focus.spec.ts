import { computeFocus, FocusBreakRecord, FocusInput } from './focus';

const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 13, h, m) - 330 * 60_000);
};
const MIN = 60;

function input(over: Partial<FocusInput> = {}): FocusInput {
  return {
    sessions: [{ startedAt: ist('09:30'), endedAt: ist('18:30') }],
    presence: [],
    breakRecords: [],
    meetingRecords: [],
    now: ist('20:00'),
    ...over,
  };
}

const skip = (over: Partial<FocusBreakRecord> = {}): FocusBreakRecord => ({
  outcome: 'SKIPPED',
  approvalStatus: 'PENDING',
  overrunAsked: false,
  overrunSec: null,
  durationMin: 15,
  ...over,
});

describe('computeFocus', () => {
  it('is Start Day to End Day when nothing else happened', () => {
    const f = computeFocus(input());
    expect(f).toMatchObject({ spanSec: 9 * 3600, breakSec: 0, focusSec: 9 * 3600, running: false });
  });

  it('takes breaks and lunch off, but not meetings', () => {
    const f = computeFocus(
      input({
        presence: [
          { type: 'BREAK', startedAt: ist('11:00'), endedAt: ist('11:15') },
          { type: 'LUNCH', startedAt: ist('13:00'), endedAt: ist('13:30') },
          { type: 'MEETING', startedAt: ist('15:00'), endedAt: ist('16:00') },
        ],
      }),
    );
    expect(f.breakSec).toBe(45 * MIN);
    expect(f.meetingSec).toBe(60 * MIN);
    expect(f.focusSec).toBe(9 * 3600 - 45 * MIN);
  });

  it('counts only the part of a break inside the work sessions', () => {
    const f = computeFocus(
      input({
        sessions: [{ startedAt: ist('09:30'), endedAt: ist('13:10') }],
        presence: [{ type: 'LUNCH', startedAt: ist('13:00'), endedAt: ist('13:40') }],
      }),
    );
    expect(f.breakSec).toBe(10 * MIN);
  });

  it('floors every instant to the whole second, so the parts add up exactly', () => {
    // 1000.6 s of work with a 0.4 s break inside one second: 1000 s of work, no break.
    const start = ist('09:30').getTime();
    const f = computeFocus(
      input({
        sessions: [{ startedAt: new Date(start), endedAt: new Date(start + 1_000_600) }],
        presence: [
          {
            type: 'BREAK',
            startedAt: new Date(start + 100_000),
            endedAt: new Date(start + 100_400),
          },
        ],
      }),
    );
    expect(f).toMatchObject({ spanSec: 1000, breakSec: 0, focusSec: 1000 });
  });

  it('focus = span - break + approved plus - rejected minus, exactly, on random days', () => {
    let seed = 20261014;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
    const base = ist('09:00').getTime();
    const at = () => new Date(base + Math.floor(rnd() * 10 * 3_600_000)); // ms precision
    const spanOf = () => {
      const a = at();
      const b = at();
      return a <= b ? [a, b] : [b, a];
    };
    const statuses = ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'] as const;
    for (let i = 0; i < 500; i++) {
      const now = new Date(base + 10 * 3_600_000 + Math.floor(rnd() * 3_600_000));
      const sessions = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const [a, b] = spanOf();
        return { startedAt: a, endedAt: rnd() < 0.2 ? null : b };
      });
      const presence = Array.from({ length: Math.floor(rnd() * 6) }, () => {
        const [a, b] = spanOf();
        return {
          type: pick(['BREAK', 'LUNCH', 'MEETING'] as const),
          startedAt: a,
          endedAt: rnd() < 0.1 ? null : b,
        };
      });
      const breakRecords = Array.from({ length: Math.floor(rnd() * 4) }, () => ({
        outcome: pick(['TAKEN', 'SKIPPED', 'AUTO_SKIPPED'] as const),
        approvalStatus: pick([...statuses]),
        overrunAsked: rnd() < 0.5,
        overrunSec: Math.floor(rnd() * 1200),
        durationMin: pick([15, 30, null]),
      }));
      const meetingRecords = Array.from({ length: Math.floor(rnd() * 3) }, () => {
        const [a, b] = spanOf();
        return {
          mode: pick(['LIVE', 'PAST'] as const),
          approvalStatus: pick([...statuses]),
          startedAt: a,
          endedAt: rnd() < 0.1 ? null : b,
        };
      });
      const f = computeFocus({ sessions, presence, breakRecords, meetingRecords, now });
      const parts = [
        f.focusSec,
        f.spanSec,
        f.breakSec,
        f.meetingSec,
        f.approvedPlusSec,
        f.pendingPlusSec,
        f.rejectedMinusSec,
        f.pendingMinusSec,
      ];
      expect(parts.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
      expect(f.focusSec).toBe(
        Math.max(0, f.spanSec - f.breakSec + f.approvedPlusSec - f.rejectedMinusSec),
      );
      expect(f.breakSec).toBeLessThanOrEqual(f.spanSec);
    }
  });

  it('sums two sessions and leaves the gap between them out (resume)', () => {
    const f = computeFocus(
      input({
        sessions: [
          { startedAt: ist('09:30'), endedAt: ist('12:00') },
          { startedAt: ist('13:00'), endedAt: ist('18:00') },
        ],
      }),
    );
    expect(f.spanSec).toBe(7.5 * 3600);
    expect(f.focusSec).toBe(7.5 * 3600);
  });

  it('runs an open session to now and ticks unless on a break', () => {
    const now = ist('12:00');
    const open = computeFocus(
      input({ sessions: [{ startedAt: ist('09:30'), endedAt: null }], now }),
    );
    expect(open).toMatchObject({ spanSec: 2.5 * 3600, running: true });
    const onBreak = computeFocus(
      input({
        sessions: [{ startedAt: ist('09:30'), endedAt: null }],
        presence: [{ type: 'BREAK', startedAt: ist('11:50'), endedAt: null }],
        now,
      }),
    );
    expect(onBreak).toMatchObject({ running: false, breakSec: 10 * MIN });
    const inMeeting = computeFocus(
      input({
        sessions: [{ startedAt: ist('09:30'), endedAt: null }],
        presence: [{ type: 'MEETING', startedAt: ist('11:50'), endedAt: null }],
        now,
      }),
    );
    expect(inMeeting).toMatchObject({ running: true, meetingSec: 10 * MIN });
  });

  it('adds an asked overrun only once approved; pending shows as a plus', () => {
    const asked = (approvalStatus: FocusBreakRecord['approvalStatus']): FocusBreakRecord => ({
      outcome: 'TAKEN',
      approvalStatus,
      overrunAsked: true,
      overrunSec: 10 * MIN,
      durationMin: 30,
    });
    const presence = [{ type: 'LUNCH' as const, startedAt: ist('13:00'), endedAt: ist('13:40') }];
    const base = 9 * 3600 - 40 * MIN;
    expect(computeFocus(input({ presence, breakRecords: [asked('PENDING')] }))).toMatchObject({
      focusSec: base,
      pendingPlusSec: 10 * MIN,
      approvedPlusSec: 0,
    });
    expect(computeFocus(input({ presence, breakRecords: [asked('APPROVED')] }))).toMatchObject({
      focusSec: base + 10 * MIN,
      approvedPlusSec: 10 * MIN,
    });
    expect(computeFocus(input({ presence, breakRecords: [asked('REJECTED')] })).focusSec).toBe(
      base,
    );
    // Not asked (left out, or within grace): nothing either way.
    expect(
      computeFocus(
        input({ presence, breakRecords: [{ ...asked('APPROVED'), overrunAsked: false }] }),
      ).focusSec,
    ).toBe(base);
    // A Super Admin's record needs no approval and has no effect.
    expect(computeFocus(input({ presence, breakRecords: [asked('NOT_REQUIRED')] })).focusSec).toBe(
      base,
    );
  });

  it('counts a skipped break as focus until a rejection takes its length off', () => {
    const day = 9 * 3600;
    expect(computeFocus(input({ breakRecords: [skip()] }))).toMatchObject({
      focusSec: day,
      pendingMinusSec: 15 * MIN,
    });
    expect(
      computeFocus(input({ breakRecords: [skip({ approvalStatus: 'APPROVED' })] })).focusSec,
    ).toBe(day);
    expect(
      computeFocus(
        input({ breakRecords: [skip({ outcome: 'AUTO_SKIPPED', approvalStatus: 'REJECTED' })] }),
      ),
    ).toMatchObject({ focusSec: day - 15 * MIN, rejectedMinusSec: 15 * MIN });
    expect(
      computeFocus(input({ breakRecords: [skip({ approvalStatus: 'NOT_REQUIRED' })] })).focusSec,
    ).toBe(day);
  });

  it('counts meetings as they happen and takes a rejected one off', () => {
    const meeting = { type: 'MEETING' as const, startedAt: ist('10:00'), endedAt: ist('10:45') };
    const record = (approvalStatus: 'PENDING' | 'REJECTED' | 'APPROVED') => ({
      mode: 'LIVE' as const,
      approvalStatus,
      startedAt: ist('10:00'),
      endedAt: ist('10:45'),
    });
    expect(
      computeFocus(input({ presence: [meeting], meetingRecords: [record('PENDING')] })),
    ).toMatchObject({ focusSec: 9 * 3600, meetingSec: 45 * MIN, pendingMinusSec: 45 * MIN });
    expect(
      computeFocus(input({ presence: [meeting], meetingRecords: [record('REJECTED')] })),
    ).toMatchObject({ focusSec: 9 * 3600 - 45 * MIN, rejectedMinusSec: 45 * MIN });
  });

  it('adds past meetings to the meeting time once, from the record', () => {
    const f = computeFocus(
      input({
        meetingRecords: [
          {
            mode: 'PAST',
            approvalStatus: 'REJECTED',
            startedAt: ist('14:00'),
            endedAt: ist('14:30'),
          },
        ],
      }),
    );
    expect(f).toMatchObject({ meetingSec: 30 * MIN, rejectedMinusSec: 30 * MIN });
    expect(f.focusSec).toBe(9 * 3600 - 30 * MIN);
  });

  it('never goes below zero and the formula holds on the returned numbers', () => {
    const f = computeFocus(
      input({
        sessions: [{ startedAt: ist('09:30'), endedAt: ist('09:40') }],
        breakRecords: [
          skip({ approvalStatus: 'REJECTED' }),
          skip({ outcome: 'AUTO_SKIPPED', approvalStatus: 'REJECTED' }),
        ],
      }),
    );
    expect(f.focusSec).toBe(0);
    const g = computeFocus(
      input({
        presence: [
          {
            type: 'BREAK',
            startedAt: ist('11:00'),
            endedAt: new Date(ist('11:15').getTime() + 499),
          },
        ],
        breakRecords: [skip({ approvalStatus: 'REJECTED' })],
      }),
    );
    expect(g.focusSec).toBe(g.spanSec - g.breakSec + g.approvedPlusSec - g.rejectedMinusSec);
  });

  it('is all zero with no sessions', () => {
    expect(computeFocus(input({ sessions: [] }))).toMatchObject({
      focusSec: 0,
      spanSec: 0,
      running: false,
    });
  });
});
