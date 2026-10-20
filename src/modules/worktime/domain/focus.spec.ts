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

// ---------------------------------------------------------------------------
// 4.0: paid allowance, buffer, quick breaks, pause/resume, away (SPEC 2.4, 2.5)
// ---------------------------------------------------------------------------

type Seg = [string, string | null];

/** A taken break record with its segments (each a presence session too, as in the database). */
function taken(kind: string | null, durationMin: number | null, segs: Seg[]): FocusBreakRecord {
  return {
    outcome: 'TAKEN',
    approvalStatus: 'NOT_REQUIRED',
    overrunAsked: false,
    overrunSec: null,
    durationMin,
    kind,
    segments: segs.map(([a, b]) => ({ startedAt: ist(a), endedAt: b ? ist(b) : null })),
  };
}

/** The presence sessions behind a record's segments. */
function presenceOf(r: FocusBreakRecord, type: 'BREAK' | 'LUNCH' = 'BREAK') {
  return (r.segments ?? []).map((g) => ({ type, startedAt: g.startedAt, endedAt: g.endedAt }));
}

/** A day with these break records (and their presence) and a 10 min buffer. */
function dayWith(
  records: { r: FocusBreakRecord; type?: 'BREAK' | 'LUNCH' }[],
  over: Partial<FocusInput> = {},
) {
  return input({
    breakRecords: records.map((x) => x.r),
    presence: records.flatMap((x) => presenceOf(x.r, x.type)),
    bufferMin: 10,
    ...over,
  });
}

describe('computeFocus: 4.0 paid break allowance', () => {
  const DAY = 9 * 3600;

  it('a scheduled break taken within its length is fully paid and leaves the buffer alone', () => {
    const lunch = taken('LUNCH', 40, [['13:00', '13:35']]);
    const f = computeFocus(dayWith([{ r: lunch, type: 'LUNCH' }]));
    expect(f).toMatchObject({
      breakSec: 35 * MIN,
      scheduledTakenSec: 35 * MIN,
      paidScheduledSec: 35 * MIN,
      overrunSec: 0,
      quickBreakSec: 0,
      otherBreakSec: 0,
      bufferUsedSec: 0,
      paidBreakSec: 35 * MIN,
      unpaidBreakSec: 0,
      focusSec: DAY - 35 * MIN,
    });
  });

  it('an overrun beyond the length is paid only from the buffer; the rest is unpaid', () => {
    const lunch = taken('LUNCH', 40, [['13:00', '13:55']]);
    const f = computeFocus(dayWith([{ r: lunch, type: 'LUNCH' }]));
    expect(f).toMatchObject({
      breakSec: 55 * MIN,
      paidScheduledSec: 40 * MIN,
      overrunSec: 15 * MIN,
      bufferUsedSec: 10 * MIN,
      paidBreakSec: 50 * MIN,
      unpaidBreakSec: 5 * MIN,
      // Break time is never focus, paid or not.
      focusSec: DAY - 55 * MIN,
    });
    // With a bigger buffer the whole overrun is paid.
    const g = computeFocus(dayWith([{ r: lunch, type: 'LUNCH' }], { bufferMin: 30 }));
    expect(g).toMatchObject({ bufferUsedSec: 15 * MIN, paidBreakSec: 55 * MIN, unpaidBreakSec: 0 });
  });

  it('quick breaks are paid from the buffer only', () => {
    const quick = taken('QUICK', null, [['15:00', '15:15']]);
    expect(computeFocus(dayWith([{ r: quick }]))).toMatchObject({
      breakSec: 15 * MIN,
      quickBreakSec: 15 * MIN,
      paidScheduledSec: 0,
      bufferUsedSec: 10 * MIN,
      paidBreakSec: 10 * MIN,
      unpaidBreakSec: 5 * MIN,
      focusSec: DAY - 15 * MIN,
    });
    // No buffer: a quick break is unpaid.
    expect(computeFocus(dayWith([{ r: quick }], { bufferMin: 0 }))).toMatchObject({
      paidBreakSec: 0,
      unpaidBreakSec: 15 * MIN,
    });
    // A 3.x caller passes no buffer: none.
    expect(computeFocus(dayWith([{ r: quick }], { bufferMin: undefined })).bufferUsedSec).toBe(0);
  });

  it('one buffer is shared by overruns, quick breaks and other break time', () => {
    const morning = taken('MORNING', 20, [['11:00', '11:25']]); // 5 min over
    const lunch = taken('LUNCH', 40, [['13:00', '13:30']]); // 10 min under, not carried over
    const quick = taken('QUICK', null, [['15:00', '15:04']]);
    const f = computeFocus(
      dayWith([{ r: morning }, { r: lunch, type: 'LUNCH' }, { r: quick }], {
        // Plus an unscheduled break from a 3.x agent: no record, 3 minutes.
        presence: [
          ...presenceOf(morning),
          ...presenceOf(lunch, 'LUNCH'),
          ...presenceOf(quick),
          { type: 'BREAK', startedAt: ist('16:00'), endedAt: ist('16:03') },
        ],
      }),
    );
    expect(f).toMatchObject({
      breakSec: 62 * MIN,
      scheduledTakenSec: 55 * MIN,
      paidScheduledSec: 50 * MIN,
      overrunSec: 5 * MIN,
      quickBreakSec: 4 * MIN,
      otherBreakSec: 3 * MIN,
      // 5 + 4 + 3 = 12 min ask for the buffer; 10 min is all there is.
      bufferUsedSec: 10 * MIN,
      paidBreakSec: 60 * MIN,
      unpaidBreakSec: 2 * MIN,
      focusSec: DAY - 62 * MIN,
    });
  });

  it('pause and resume: segments are summed, and the gap between them is work', () => {
    const lunch = taken('LUNCH', 40, [
      ['13:00', '13:15'],
      ['13:30', '13:50'],
    ]);
    const f = computeFocus(dayWith([{ r: lunch, type: 'LUNCH' }]));
    expect(f).toMatchObject({
      breakSec: 35 * MIN,
      scheduledTakenSec: 35 * MIN,
      paidScheduledSec: 35 * MIN,
      overrunSec: 0,
      paidBreakSec: 35 * MIN,
      focusSec: DAY - 35 * MIN,
    });
    // Three segments that together run over: the overrun is on their sum.
    const long = taken('LUNCH', 40, [
      ['13:00', '13:20'],
      ['13:30', '13:50'],
      ['14:00', '14:10'],
    ]);
    expect(computeFocus(dayWith([{ r: long, type: 'LUNCH' }]))).toMatchObject({
      scheduledTakenSec: 50 * MIN,
      overrunSec: 10 * MIN,
      bufferUsedSec: 10 * MIN,
      paidBreakSec: 50 * MIN,
      unpaidBreakSec: 0,
    });
  });

  it('a paused break lets focus tick; an open segment runs to now and stops it', () => {
    const sessions = [{ startedAt: ist('09:30'), endedAt: null }];
    const paused = taken('LUNCH', 40, [['13:00', '13:15']]);
    const p = computeFocus(
      dayWith([{ r: paused, type: 'LUNCH' }], { sessions, now: ist('13:20') }),
    );
    expect(p).toMatchObject({
      running: true,
      breakSec: 15 * MIN,
      focusSec: 3 * 3600 + 50 * MIN - 15 * MIN,
    });

    const resumed = taken('LUNCH', 40, [
      ['13:00', '13:15'],
      ['13:30', null],
    ]);
    const r = computeFocus(
      dayWith([{ r: resumed, type: 'LUNCH' }], { sessions, now: ist('13:40') }),
    );
    expect(r).toMatchObject({
      running: false,
      breakSec: 25 * MIN,
      scheduledTakenSec: 25 * MIN,
      paidBreakSec: 25 * MIN,
    });
  });

  it('only the part of a segment inside the work sessions counts', () => {
    const quick = taken('QUICK', null, [['18:20', '18:45']]);
    const f = computeFocus(dayWith([{ r: quick }]));
    expect(f).toMatchObject({
      breakSec: 10 * MIN,
      quickBreakSec: 10 * MIN,
      paidBreakSec: 10 * MIN,
    });
  });

  it('skips carry no break time even with segments; their 3.x minus still applies', () => {
    const rejectedSkip: FocusBreakRecord = {
      ...taken('MORNING', 15, [['11:00', '11:15']]),
      outcome: 'SKIPPED',
      approvalStatus: 'REJECTED',
    };
    const f = computeFocus(input({ breakRecords: [rejectedSkip], bufferMin: 10 }));
    expect(f).toMatchObject({
      breakSec: 0,
      scheduledTakenSec: 0,
      paidBreakSec: 0,
      rejectedMinusSec: 15 * MIN,
    });
  });
});

describe('computeFocus: 4.0 away time', () => {
  const DAY = 9 * 3600;
  type AwayStatus = 'UNEXPLAINED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'NOT_REQUIRED';
  const away = (status: AwayStatus, a: string, b: string | null) => ({
    status,
    startedAt: ist(a),
    endedAt: b ? ist(b) : null,
  });

  it('pending, rejected and unexplained away time is not focus; approved is', () => {
    const f = computeFocus(
      input({
        away: [
          away('PENDING', '10:00', '10:20'),
          away('APPROVED', '11:00', '11:30'),
          away('REJECTED', '14:00', '14:10'),
          away('UNEXPLAINED', '16:00', '16:05'),
          away('NOT_REQUIRED', '17:00', '17:10'),
        ],
      }),
    );
    expect(f).toMatchObject({
      awayPendingSec: 20 * MIN,
      awayApprovedSec: 30 * MIN,
      awayRejectedSec: 10 * MIN,
      awayUnexplainedSec: 5 * MIN,
      breakSec: 0,
      focusSec: DAY - 35 * MIN,
    });
  });

  it('pendingPlusSec includes pending away time (with any 3.x pending overrun)', () => {
    const asked: FocusBreakRecord = {
      outcome: 'TAKEN',
      approvalStatus: 'PENDING',
      overrunAsked: true,
      overrunSec: 10 * MIN,
      durationMin: 30,
    };
    const f = computeFocus(
      input({
        away: [away('PENDING', '10:00', '10:20'), away('REJECTED', '12:00', '12:05')],
        breakRecords: [asked],
      }),
    );
    expect(f.awayPendingSec).toBe(20 * MIN);
    expect(f.pendingPlusSec).toBe(30 * MIN);
    // Approving the away item adds exactly that much.
    const approved = computeFocus(
      input({
        away: [away('APPROVED', '10:00', '10:20'), away('REJECTED', '12:00', '12:05')],
        breakRecords: [asked],
      }),
    );
    expect(approved.focusSec - f.focusSec).toBe(f.awayPendingSec);
    expect(approved.pendingPlusSec).toBe(10 * MIN);
  });

  it('away time overlapping a break counts once, as break', () => {
    const presence = [{ type: 'BREAK' as const, startedAt: ist('10:00'), endedAt: ist('10:15') }];
    for (const status of ['PENDING', 'REJECTED', 'UNEXPLAINED'] as const) {
      const f = computeFocus(input({ presence, away: [away(status, '09:55', '10:20')] }));
      expect(f.breakSec).toBe(15 * MIN);
      expect(f.focusSec).toBe(DAY - 25 * MIN);
    }
    const ok = computeFocus(input({ presence, away: [away('APPROVED', '09:55', '10:20')] }));
    expect(ok).toMatchObject({
      breakSec: 15 * MIN,
      awayApprovedSec: 10 * MIN,
      focusSec: DAY - 15 * MIN,
    });
    // Entirely inside the break: no away time at all.
    const inside = computeFocus(input({ presence, away: [away('PENDING', '10:05', '10:10')] }));
    expect(inside).toMatchObject({
      awayPendingSec: 0,
      pendingPlusSec: 0,
      focusSec: DAY - 15 * MIN,
    });
  });

  it('only away time inside the work sessions counts; an open away runs to now', () => {
    const f = computeFocus(input({ away: [away('UNEXPLAINED', '18:15', '19:00')] }));
    expect(f.awayUnexplainedSec).toBe(15 * MIN);
    const open = computeFocus(
      input({
        sessions: [{ startedAt: ist('09:30'), endedAt: null }],
        now: ist('12:00'),
        away: [away('UNEXPLAINED', '11:40', null)],
      }),
    );
    expect(open).toMatchObject({
      awayUnexplainedSec: 20 * MIN,
      focusSec: 2.5 * 3600 - 20 * MIN,
      running: true,
    });
  });
});

describe('computeFocus: 4.0 identities on random days', () => {
  it('focus = span − break − away (pending, rejected, unexplained) + approved plus − rejected minus; paid + unpaid = break', () => {
    let seed = 20261020;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    const base = ist('09:00').getTime();
    const at = () => new Date(base + Math.floor(rnd() * 10 * 3_600_000)); // ms precision
    const spanOf = (): [Date, Date] => {
      const a = at();
      const b = at();
      return a <= b ? [a, b] : [b, a];
    };
    const statuses = ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED'] as const;
    const awayStatuses = [
      'UNEXPLAINED',
      'PENDING',
      'APPROVED',
      'REJECTED',
      'NOT_REQUIRED',
    ] as const;
    // How often each interesting case came up, so the run is known to cover them.
    const seen = {
      overrun: 0,
      quick: 0,
      other: 0,
      bufferFull: 0,
      unpaid: 0,
      awayPending: 0,
      awayApproved: 0,
      clamped: 0,
    };

    for (let i = 0; i < 800; i++) {
      const now = new Date(base + 10 * 3_600_000 + Math.floor(rnd() * 3_600_000));
      const bufferMin = pick([0, 5, 10, 30, 60]);
      const sessions = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const [a, b] = spanOf();
        return { startedAt: a, endedAt: rnd() < 0.2 ? null : b };
      });
      const presence: FocusInput['presence'] = [];
      const breakRecords: FocusBreakRecord[] = [];
      let scheduledLengthsSec = 0;

      // Scheduled and quick breaks with 1 to 3 segments, each its own presence session.
      for (let k = Math.floor(rnd() * 4); k > 0; k--) {
        const kind = pick(['MORNING', 'LUNCH', 'EVENING', 'QUICK'] as const);
        const durationMin = kind === 'QUICK' ? null : pick([15, 20, 30, 40]);
        const segments = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
          const [a, b] = spanOf();
          return { startedAt: a, endedAt: rnd() < 0.05 ? null : b };
        });
        for (const g of segments)
          presence.push({ type: kind === 'LUNCH' ? 'LUNCH' : 'BREAK', ...g });
        breakRecords.push({
          outcome: 'TAKEN',
          approvalStatus: 'NOT_REQUIRED',
          overrunAsked: false,
          overrunSec: null,
          durationMin,
          kind,
          segments,
        });
        if (durationMin) scheduledLengthsSec += durationMin * 60;
      }
      // Other break time and meetings (3.x agents).
      for (let k = Math.floor(rnd() * 4); k > 0; k--) {
        const [a, b] = spanOf();
        presence.push({
          type: pick(['BREAK', 'LUNCH', 'MEETING'] as const),
          startedAt: a,
          endedAt: rnd() < 0.1 ? null : b,
        });
      }
      // 3.x records: skips and overrun asks.
      for (let k = Math.floor(rnd() * 3); k > 0; k--) {
        breakRecords.push({
          outcome: pick(['TAKEN', 'SKIPPED', 'AUTO_SKIPPED'] as const),
          approvalStatus: pick(statuses),
          overrunAsked: rnd() < 0.5,
          overrunSec: Math.floor(rnd() * 1200),
          durationMin: pick([15, 30, null]),
        });
      }
      const meetingRecords = Array.from({ length: Math.floor(rnd() * 3) }, () => {
        const [a, b] = spanOf();
        return {
          mode: pick(['LIVE', 'PAST'] as const),
          approvalStatus: pick(statuses),
          startedAt: a,
          endedAt: rnd() < 0.1 ? null : b,
        };
      });
      // Away stretches one after another (they never overlap each other).
      const away: NonNullable<FocusInput['away']> = [];
      let cursor = base + Math.floor(rnd() * 3_600_000);
      for (let k = Math.floor(rnd() * 5); k > 0; k--) {
        const start = cursor + Math.floor(rnd() * 3_600_000);
        const end = start + Math.floor(rnd() * 3_600_000);
        const open = k === 1 && rnd() < 0.05;
        away.push({
          status: pick(awayStatuses),
          startedAt: new Date(start),
          endedAt: open ? null : new Date(end),
        });
        cursor = end;
      }

      const f = computeFocus({
        sessions,
        presence,
        breakRecords,
        meetingRecords,
        away,
        bufferMin,
        now,
      });

      const numbers = Object.entries(f)
        .filter(([k]) => k !== 'running')
        .map(([, v]) => v as number);
      expect(numbers.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
      expect(f.focusSec).toBe(
        Math.max(
          0,
          f.spanSec -
            f.breakSec -
            f.awayPendingSec -
            f.awayRejectedSec -
            f.awayUnexplainedSec +
            f.approvedPlusSec -
            f.rejectedMinusSec,
        ),
      );
      expect(f.paidBreakSec + f.unpaidBreakSec).toBe(f.breakSec);
      // Live sessions only: nothing is unverified, and paid time is focus + paid breaks.
      expect(f.unverifiedSec).toBe(0);
      expect(f.paidSec).toBe(f.focusSec + f.paidBreakSec);
      expect(f.paidBreakSec).toBeLessThanOrEqual(scheduledLengthsSec + bufferMin * 60);
      expect(f.bufferUsedSec).toBeLessThanOrEqual(bufferMin * 60);
      expect(f.paidScheduledSec).toBeLessThanOrEqual(f.scheduledTakenSec);
      expect(f.scheduledTakenSec + f.quickBreakSec + f.otherBreakSec).toBe(f.breakSec);
      expect(f.breakSec).toBeLessThanOrEqual(f.spanSec);
      expect(
        f.breakSec +
          f.awayPendingSec +
          f.awayApprovedSec +
          f.awayRejectedSec +
          f.awayUnexplainedSec,
      ).toBeLessThanOrEqual(f.spanSec);
      expect(f.pendingPlusSec).toBeGreaterThanOrEqual(f.awayPendingSec);

      if (f.overrunSec > 0) seen.overrun++;
      if (f.quickBreakSec > 0) seen.quick++;
      if (f.otherBreakSec > 0) seen.other++;
      if (bufferMin > 0 && f.bufferUsedSec === bufferMin * 60) seen.bufferFull++;
      if (f.unpaidBreakSec > 0) seen.unpaid++;
      if (f.awayPendingSec > 0) seen.awayPending++;
      if (f.awayApprovedSec > 0) seen.awayApproved++;
      if (f.focusSec === 0 && f.spanSec > 0) seen.clamped++;
    }
    for (const [what, n] of Object.entries(seen)) {
      expect([what, n > 5]).toEqual([what, true]);
    }
  });
});

describe('computeFocus: 4.0 offline evidence (REPLAY sessions)', () => {
  const DAY = 9 * 3600;
  const replayDay = { startedAt: ist('09:30'), endedAt: ist('18:30'), replay: true };
  /** One sample a minute from `a` to `b` (each covering its minute), as joined coverage. */
  const covered = (a: string, b: string) => ({ startedAt: ist(a), endedAt: ist(b) });
  const lunch = (): FocusBreakRecord => ({
    outcome: 'TAKEN',
    approvalStatus: 'NOT_REQUIRED',
    overrunAsked: false,
    overrunSec: null,
    durationMin: 40,
    kind: 'LUNCH',
    segments: [{ startedAt: ist('13:00'), endedAt: ist('13:40') }],
  });
  const lunchPresence = [
    { type: 'LUNCH' as const, startedAt: ist('13:00'), endedAt: ist('13:40') },
  ];

  it('a replayed day with no activity at all (a forged day) is no focus and no pay: all of it unverified', () => {
    const f = computeFocus(input({ sessions: [replayDay] }));
    expect(f).toMatchObject({
      spanSec: DAY,
      focusSec: 0,
      unverifiedSec: DAY,
      paidSec: 0,
      paidBreakSec: 0,
    });
    // Its breaks are not paid either (no evidence of them), but they stay break time,
    // reported once (as unpaid break), not again inside the unverified time.
    const g = computeFocus(
      input({
        sessions: [replayDay],
        presence: lunchPresence,
        breakRecords: [lunch()],
        bufferMin: 10,
      }),
    );
    expect(g).toMatchObject({
      focusSec: 0,
      breakSec: 40 * MIN,
      paidBreakSec: 0,
      paidScheduledSec: 0,
      bufferUsedSec: 0,
      unpaidBreakSec: 40 * MIN,
      unverifiedSec: DAY - 40 * MIN,
      paidSec: 0,
    });
    expect(g.focusSec + g.breakSec + g.unverifiedSec).toBe(g.spanSec);
  });

  it('a replayed day the agent covered counts exactly like a live one', () => {
    const live = computeFocus(
      input({ presence: lunchPresence, breakRecords: [lunch()], bufferMin: 10 }),
    );
    const replayed = computeFocus(
      input({
        sessions: [replayDay],
        coverage: [covered('09:30', '18:30')],
        presence: lunchPresence,
        breakRecords: [lunch()],
        bufferMin: 10,
      }),
    );
    expect(replayed).toEqual(live);
    expect(replayed).toMatchObject({
      focusSec: DAY - 40 * MIN,
      unverifiedSec: 0,
      paidBreakSec: 40 * MIN,
      paidSec: DAY,
    });
  });

  it('only the uncovered stretch is unverified; gaps of up to 2 minutes are joined', () => {
    const f = computeFocus(
      input({
        sessions: [replayDay],
        coverage: [covered('09:30', '11:00'), covered('11:02', '12:00'), covered('13:00', '18:30')],
      }),
    );
    // 11:00 to 11:02 is joined; 12:00 to 13:00 (an hour with the agent not running) is not.
    expect(f).toMatchObject({
      unverifiedSec: 60 * MIN,
      focusSec: DAY - 60 * MIN,
      paidSec: DAY - 60 * MIN,
    });
    const gap = computeFocus(
      input({
        sessions: [replayDay],
        coverage: [covered('09:30', '11:00'), covered('11:03', '18:30')],
      }),
    );
    expect(gap.unverifiedSec).toBe(3 * MIN);
  });

  it('the start and end of the session join the first and last samples within 2 minutes', () => {
    const near = computeFocus(
      input({ sessions: [replayDay], coverage: [covered('09:32', '18:28')] }),
    );
    expect(near).toMatchObject({ unverifiedSec: 0, focusSec: DAY });
    const far = computeFocus(
      input({ sessions: [replayDay], coverage: [covered('09:35', '18:25')] }),
    );
    expect(far).toMatchObject({ unverifiedSec: 10 * MIN, focusSec: DAY - 10 * MIN });
  });

  it('a session edge never covers by itself: a day split into 2-minute replayed sessions with no samples is all unverified', () => {
    // Re-audit H1: 30 replayed Start/End pairs, each session 2 minutes long and 2
    // minutes after the last, and not one sample.
    const sessions = Array.from({ length: 30 }, (_, i) => ({
      startedAt: new Date(ist('09:30').getTime() + i * 4 * MIN * 1000),
      endedAt: new Date(ist('09:30').getTime() + (i * 4 + 2) * MIN * 1000),
      replay: true,
    }));
    const f = computeFocus(input({ sessions }));
    expect(f).toMatchObject({ spanSec: 3600, focusSec: 0, unverifiedSec: 3600, paidSec: 0 });
    // One session's samples never stretch to the next session's edges.
    const two = computeFocus(
      input({
        sessions: [
          { startedAt: ist('09:30'), endedAt: ist('10:00'), replay: true },
          { startedAt: ist('10:01'), endedAt: ist('10:02'), replay: true },
        ],
        coverage: [covered('09:30', '10:00')],
      }),
    );
    expect(two).toMatchObject({ unverifiedSec: 60, focusSec: 30 * MIN });
  });

  it('approved meetings and approved away are evidence like samples; pending ones are not', () => {
    const meeting = (approvalStatus: 'APPROVED' | 'PENDING', mode: 'LIVE' | 'PAST') => ({
      mode,
      approvalStatus,
      startedAt: ist('15:00'),
      endedAt: ist('15:30'),
    });
    for (const mode of ['LIVE', 'PAST'] as const) {
      const approved = computeFocus(
        input({ sessions: [replayDay], meetingRecords: [meeting('APPROVED', mode)] }),
      );
      expect(approved).toMatchObject({ unverifiedSec: DAY - 30 * MIN, focusSec: 30 * MIN });
      const pending = computeFocus(
        input({ sessions: [replayDay], meetingRecords: [meeting('PENDING', mode)] }),
      );
      expect(pending).toMatchObject({ unverifiedSec: DAY, focusSec: 0 });
    }
    // Approved away joins samples 2 minutes away like any other evidence.
    const f = computeFocus(
      input({
        sessions: [replayDay],
        coverage: [covered('09:30', '12:00')],
        away: [{ status: 'APPROVED', startedAt: ist('12:02'), endedAt: ist('18:30') }],
      }),
    );
    expect(f).toMatchObject({ unverifiedSec: 0, focusSec: DAY });
  });

  it('an open replayed session runs to now; samples up to 2 minutes old keep it covered', () => {
    const open = { startedAt: ist('09:30'), endedAt: null, replay: true };
    const f = computeFocus(
      input({ sessions: [open], now: ist('12:00'), coverage: [covered('09:30', '11:59')] }),
    );
    expect(f).toMatchObject({
      spanSec: 2.5 * 3600,
      unverifiedSec: 0,
      focusSec: 2.5 * 3600,
      running: true,
    });
    const stale = computeFocus(
      input({ sessions: [open], now: ist('12:00'), coverage: [covered('09:30', '11:30')] }),
    );
    expect(stale.unverifiedSec).toBe(30 * MIN);
  });

  it('live sessions on the same day need no samples', () => {
    const f = computeFocus(
      input({
        sessions: [
          { startedAt: ist('09:30'), endedAt: ist('12:00') },
          { startedAt: ist('13:00'), endedAt: ist('18:30'), replay: true },
        ],
        coverage: [covered('13:00', '17:30')],
      }),
    );
    expect(f).toMatchObject({ spanSec: 8 * 3600, unverifiedSec: 60 * MIN, focusSec: 7 * 3600 });
  });

  it('away time and rejected meetings are decided by their status, never also unverified', () => {
    const away = [
      { status: 'PENDING' as const, startedAt: ist('10:00'), endedAt: ist('10:30') },
      { status: 'APPROVED' as const, startedAt: ist('11:00'), endedAt: ist('11:20') },
    ];
    const meetingRecords = [
      {
        mode: 'PAST' as const,
        approvalStatus: 'REJECTED' as const,
        startedAt: ist('15:00'),
        endedAt: ist('15:30'),
      },
    ];
    const f = computeFocus(input({ sessions: [replayDay], away, meetingRecords }));
    // Everything else is uncovered: 9 h − 30 min pending − 20 min approved − 30 min rejected meeting.
    expect(f.unverifiedSec).toBe(DAY - 80 * MIN);
    expect(f.awayPendingSec).toBe(30 * MIN);
    expect(f.rejectedMinusSec).toBe(30 * MIN);
    // Approved away counts (a decision is evidence); nothing is taken off twice.
    expect(f.focusSec).toBe(20 * MIN);
    expect(f.pendingPlusSec).toBe(30 * MIN);
  });

  it('on random days: unverified time only ever takes focus off, and the payroll identities hold', () => {
    let seed = 4040;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const base = ist('09:00').getTime();
    const at = () => new Date(base + Math.floor(rnd() * 10 * 3_600_000));
    for (let i = 0; i < 400; i++) {
      const now = new Date(base + 10 * 3_600_000);
      const sessions = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const [a, b] = [at(), at()].sort((x, y) => x.getTime() - y.getTime());
        return { startedAt: a, endedAt: rnd() < 0.2 ? null : b, replay: rnd() < 0.6 };
      });
      const coverage = Array.from({ length: Math.floor(rnd() * 6) }, () => {
        const [a, b] = [at(), at()].sort((x, y) => x.getTime() - y.getTime());
        return { startedAt: a, endedAt: b };
      });
      const presence = Array.from({ length: Math.floor(rnd() * 3) }, () => {
        const [a, b] = [at(), at()].sort((x, y) => x.getTime() - y.getTime());
        return { type: 'BREAK' as const, startedAt: a, endedAt: b };
      });
      const breakRecords: FocusBreakRecord[] = presence.map((p) => ({
        outcome: 'TAKEN',
        approvalStatus: 'NOT_REQUIRED',
        overrunAsked: false,
        overrunSec: null,
        durationMin: 30,
        kind: 'MORNING',
        segments: [p],
      }));
      const base4 = { sessions, presence, breakRecords, meetingRecords: [], bufferMin: 10, now };
      const f = computeFocus({ ...base4, coverage });
      const live = computeFocus({
        ...base4,
        sessions: sessions.map((s) => ({ ...s, replay: false })),
      });
      expect(f.unverifiedSec).toBeGreaterThanOrEqual(0);
      expect(f.unverifiedSec).toBeLessThanOrEqual(f.spanSec);
      expect(f.focusSec).toBeLessThanOrEqual(live.focusSec);
      expect(f.focusSec).toBeGreaterThanOrEqual(Math.max(0, live.focusSec - f.unverifiedSec));
      expect(f.paidBreakSec).toBeLessThanOrEqual(live.paidBreakSec);
      expect(f.paidBreakSec + f.unpaidBreakSec).toBe(f.breakSec);
      expect(f.paidSec).toBe(f.focusSec + f.paidBreakSec);
      if (!sessions.some((s) => s.replay)) expect(f).toEqual(live);
    }
  });
});
