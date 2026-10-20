import { BreakRecordRow } from '@modules/shifts/domain/break-record.repository';
import { focusOfDay, PersonDayData } from '@modules/worktime/domain/day';
import { MeetingRecordRow } from '@modules/worktime/domain/meeting-record.repository';
import { WorkSessionRecord } from '@modules/worktime/domain/work-session.repository';
import { PresenceRow } from '@modules/worktime/domain/worktime.reader';
import {
  beforeJoining,
  buildTimeline,
  DaySummaryInput,
  emptyTotals,
  monthDates,
  monthRangeProblem,
  monthTotals,
  summarizeDay,
  teamTotals,
  withPayrollFields,
} from './report-builder';
import { MonthTotals, PersonDaySummary } from './report.types';

// September 2026: Tue 1st; Sun 6th; Mon 7th.
const IST_OFFSET_MS = 330 * 60_000;
const at = (date: string, hm: string) => {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, h, mi) - IST_OFFSET_MS);
};
const H = 3600;

const SHIFT = {
  start: '09:30',
  end: '18:30',
  workDays: [1, 2, 3, 4, 5],
  breaks: [
    { enabled: true, durationMin: 15 },
    { enabled: true, durationMin: 30 },
    { enabled: true, durationMin: 15 },
  ],
  overrunGraceMin: 3,
};

function session(
  date: string,
  from: string,
  to: string | null,
  over: Partial<WorkSessionRecord> = {},
): WorkSessionRecord {
  return {
    id: `s-${date}-${from}`,
    userId: 'u1',
    date,
    startedAt: at(date, from),
    endedAt: to ? at(date, to) : null,
    endReason: to ? 'USER' : null,
    source: 'AGENT',
    ...over,
  };
}

function presence(
  date: string,
  type: PresenceRow['type'],
  from: string,
  to: string | null,
  over: Partial<PresenceRow> = {},
): PresenceRow {
  return {
    id: `p-${date}-${from}`,
    userId: 'u1',
    type,
    note: null,
    date,
    startedAt: at(date, from),
    endedAt: to ? at(date, to) : null,
    ...over,
  };
}

function breakRow(date: string, over: Partial<BreakRecordRow> = {}): BreakRecordRow {
  return {
    id: `b-${date}-${over.kind ?? 'MORNING'}`,
    userId: 'u1',
    date,
    kind: 'MORNING',
    seq: 1,
    presenceType: 'BREAK',
    shiftId: 'sh1',
    shiftName: 'General',
    scheduledStart: at(date, '11:00'),
    durationMin: 15,
    windowOpen: at(date, '10:45'),
    windowClose: at(date, '11:30'),
    ringStart: null,
    ringEnd: null,
    presenceSessionId: null,
    startedAt: at(date, '11:00'),
    endedAt: at(date, '11:15'),
    timing: 'ON_TIME',
    minutesOff: 0,
    reason: null,
    overrunReason: null,
    source: 'AGENT',
    approvalStatus: 'NOT_REQUIRED',
    approverRole: null,
    approverId: null,
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: at(date, '11:00'),
    outcome: 'TAKEN',
    overrunSec: 0,
    overrunAsked: false,
    ...over,
  };
}

function pastMeeting(date: string, from: string, to: string, agenda: string): MeetingRecordRow {
  return {
    id: `m-${date}-${from}`,
    userId: 'u1',
    date,
    mode: 'PAST',
    agenda,
    participants: [],
    startedAt: at(date, from),
    endedAt: at(date, to),
    durationSec: (at(date, to).getTime() - at(date, from).getTime()) / 1000,
    presenceSessionId: null,
    approvalStatus: 'PENDING',
    approverRole: 'MANAGER',
    approverId: 'm1',
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    dueAt: null,
    escalatedAt: null,
    remindedAt: null,
    createdAt: at(date, to),
  };
}

function day(date: string, over: Partial<PersonDayData> = {}): PersonDayData {
  return {
    userId: 'u1',
    date,
    sessions: [],
    presence: [],
    breakRecords: [],
    meetingRecords: [],
    ...over,
  };
}

const NOW = at('2026-09-30', '20:00');

function summarize(d: PersonDayData, over: Partial<DaySummaryInput> = {}): PersonDaySummary {
  const now = over.now ?? NOW;
  return summarizeDay({
    date: d.date,
    today: '2026-09-30',
    data: d,
    focus: focusOfDay(d, now),
    hourly: [],
    shift: SHIFT,
    shiftStart: at(d.date, '09:30'),
    pending: 0,
    settings: { fullDayPct: 80, halfDayPct: 40, lateStartGraceMin: 10 },
    now,
    ...over,
  });
}

describe('summarizeDay (4.0 calendar, target and allowance)', () => {
  const plan = (
    over: Partial<{ isWorkingDay: boolean; label: string | null; targetSec: number }> = {},
  ) => ({
    isWorkingDay: true,
    label: null,
    targetSec: 9 * H - 70 * 60,
    ...over,
  });

  it('the target is the plan (shift − scheduled breaks − buffer), and the day class follows it', () => {
    const date = '2026-09-07';
    const d = day(date, {
      sessions: [session(date, '09:30', '18:30')],
      presence: [presence(date, 'LUNCH', '13:00', '13:45')],
      breakRecords: [
        breakRow(date, {
          kind: 'LUNCH',
          presenceType: 'LUNCH',
          durationMin: 30,
          startedAt: at(date, '13:00'),
          endedAt: at(date, '13:45'),
          overrunSec: 900,
        }),
      ],
    });
    const s = summarize(d, { focus: focusOfDay(d, NOW, 10), plan: plan() });
    expect(s).toMatchObject({
      workday: true,
      label: null,
      targetSec: 9 * H - 70 * 60,
      expectedSec: 9 * H - 70 * 60,
      focusSec: 9 * H - 45 * 60,
      breakSec: 45 * 60,
      paidBreakSec: 40 * 60,
      unpaidBreakSec: 5 * 60,
      dayClass: 'FULL',
    });
  });

  it('the calendar decides the working day: a holiday is OFF with its label, a working Saturday expects time', () => {
    // Monday 7 Sep made a holiday.
    const holiday = summarize(day('2026-09-07'), {
      plan: plan({ isWorkingDay: false, label: 'Onam', targetSec: 0 }),
    });
    expect(holiday).toMatchObject({
      workday: false,
      dayClass: 'OFF',
      label: 'Onam',
      targetSec: 0,
      expectedSec: 0,
    });
    const workedHoliday = summarize(
      day('2026-09-07', { sessions: [session('2026-09-07', '10:00', '12:00')] }),
      {
        plan: plan({ isWorkingDay: false, label: 'Onam', targetSec: 0 }),
      },
    );
    expect(workedHoliday).toMatchObject({ dayClass: 'EXTRA', label: 'Onam' });
    // Saturday 12 Sep is not in the shift's work days, but the calendar says it is a working day.
    const saturday = summarize(day('2026-09-12'), { plan: plan() });
    expect(saturday).toMatchObject({
      workday: true,
      dayClass: 'ABSENT',
      targetSec: 9 * H - 70 * 60,
    });
  });

  it('a future working day keeps its target but expects nothing yet', () => {
    const s = summarize(day('2026-10-02'), { today: '2026-09-30', plan: plan() });
    expect(s).toMatchObject({ dayClass: 'UPCOMING', targetSec: 9 * H - 70 * 60, expectedSec: 0 });
  });

  it('before joining there is no target even on a working day', () => {
    expect(summarize(day('2026-09-07'), { joinedOn: '2026-09-15', plan: plan() })).toMatchObject({
      workday: false,
      targetSec: 0,
      dayClass: 'OFF',
    });
  });

  it('passes the away time through by status', () => {
    const date = '2026-09-07';
    const d = day(date, {
      sessions: [session(date, '09:30', '18:30')],
      away: [
        { status: 'APPROVED', startedAt: at(date, '10:00'), endedAt: at(date, '10:20') },
        { status: 'PENDING', startedAt: at(date, '11:00'), endedAt: at(date, '11:10') },
        { status: 'REJECTED', startedAt: at(date, '12:00'), endedAt: at(date, '12:05') },
        { status: 'UNEXPLAINED', startedAt: at(date, '14:00'), endedAt: at(date, '14:15') },
      ] as never,
    });
    const s = summarize(d, { plan: plan() });
    expect(s).toMatchObject({
      awayApprovedSec: 20 * 60,
      awayPendingSec: 10 * 60,
      awayRejectedSec: 5 * 60,
      awayUnexplainedSec: 15 * 60,
      focusSec: 9 * H - 30 * 60,
      pendingPlusSec: 10 * 60,
    });
  });

  it('a 3.1 caller (no plan) keeps the shift days and shift − breaks as the target', () => {
    const s = summarize(day('2026-09-07', { sessions: [session('2026-09-07', '09:30', '18:30')] }));
    expect(s).toMatchObject({ label: null, targetSec: 8 * H, expectedSec: 8 * H });
    expect(summarize(day('2026-09-12')).workday).toBe(false);
  });
});

describe('summarizeDay', () => {
  it('a full day: focus at least 80% of shift length minus breaks', () => {
    const s = summarize(
      day('2026-09-07', {
        sessions: [session('2026-09-07', '09:30', '18:30')],
        presence: [
          presence('2026-09-07', 'BREAK', '11:00', '11:15'),
          presence('2026-09-07', 'LUNCH', '13:00', '13:30'),
        ],
      }),
    );
    expect(s).toMatchObject({
      date: '2026-09-07',
      weekday: 1,
      workday: true,
      dayClass: 'FULL',
      expectedSec: 8 * H,
      focusSec: 9 * H - 45 * 60,
      breakSec: 45 * 60,
      lateStart: null,
      autoClosed: false,
      startedAt: at('2026-09-07', '09:30').toISOString(),
      endedAt: at('2026-09-07', '18:30').toISOString(),
    });
  });

  it('a half day and an absent day by the percentages', () => {
    expect(
      summarize(day('2026-09-08', { sessions: [session('2026-09-08', '09:30', '13:30')] }))
        .dayClass,
    ).toBe('HALF');
    expect(
      summarize(day('2026-09-09', { sessions: [session('2026-09-09', '09:30', '12:30')] }))
        .dayClass,
    ).toBe('ABSENT');
    const none = summarize(day('2026-09-10'));
    expect(none).toMatchObject({ dayClass: 'ABSENT', startedAt: null, endedAt: null, focusSec: 0 });
  });

  it('a late start beyond the grace is reported in whole minutes', () => {
    const late = summarize(
      day('2026-09-07', { sessions: [session('2026-09-07', '09:45', '18:30')] }),
    );
    expect(late.lateStart).toEqual({ minutes: 15 });
    const inGrace = summarize(
      day('2026-09-07', { sessions: [session('2026-09-07', '09:40', '18:30')] }),
    );
    expect(inGrace.lateStart).toBeNull();
  });

  it('a day off is OFF, or EXTRA when they worked, and expects nothing', () => {
    expect(summarize(day('2026-09-06'))).toMatchObject({
      dayClass: 'OFF',
      workday: false,
      expectedSec: 0,
    });
    const extra = summarize(
      day('2026-09-06', { sessions: [session('2026-09-06', '10:00', '13:00')] }),
    );
    expect(extra).toMatchObject({
      dayClass: 'EXTRA',
      workday: false,
      expectedSec: 0,
      focusSec: 3 * H,
    });
    expect(extra.lateStart).toBeNull();
  });

  it('today is IN_PROGRESS with no end yet; a future day is UPCOMING and expects nothing yet', () => {
    const now = at('2026-09-30', '12:00');
    const today = summarize(
      day('2026-09-30', { sessions: [session('2026-09-30', '09:30', null)] }),
      { now },
    );
    expect(today).toMatchObject({
      dayClass: 'IN_PROGRESS',
      endedAt: null,
      focusSec: 2.5 * H,
      expectedSec: 8 * H,
    });
    const future = summarize(day('2026-10-01'), { today: '2026-09-30', now });
    expect(future).toMatchObject({ dayClass: 'UPCOMING', expectedSec: 0 });
  });

  it('days before the person joined are days off unless they worked', () => {
    expect(summarize(day('2026-09-07'), { joinedOn: '2026-09-15' })).toMatchObject({
      dayClass: 'OFF',
      workday: false,
      expectedSec: 0,
    });
    expect(summarize(day('2026-09-15'), { joinedOn: '2026-09-15' }).dayClass).toBe('ABSENT');
    const worked = summarize(
      day('2026-09-07', { sessions: [session('2026-09-07', '09:30', '18:30')] }),
      {
        joinedOn: '2026-09-15',
      },
    );
    expect(worked).toMatchObject({ workday: true, dayClass: 'FULL' });
    expect(beforeJoining('2026-09-01', undefined, false)).toBe(false);
  });

  it('counts breaks taken, skips, auto-skips and overruns past the grace', () => {
    const date = '2026-09-07';
    const s = summarize(
      day(date, {
        sessions: [session(date, '09:30', '18:30', { endReason: 'AUTO_CLOSED' })],
        breakRecords: [
          breakRow(date, { kind: 'MORNING', overrunSec: 600 }),
          breakRow(date, {
            kind: 'LUNCH',
            presenceType: 'LUNCH',
            durationMin: 30,
            overrunSec: 120,
          }),
          breakRow(date, {
            kind: 'EVENING',
            outcome: 'SKIPPED',
            endedAt: null,
            approvalStatus: 'PENDING',
          }),
          breakRow(date, { kind: null, seq: 2, outcome: 'TAKEN', endedAt: null, overrunSec: null }),
        ],
      }),
    );
    expect(s).toMatchObject({
      breaksTaken: 3,
      skipped: 1,
      autoSkipped: 0,
      overruns: 1,
      autoClosed: true,
    });
    const auto = summarize(
      day(date, {
        breakRecords: [breakRow(date, { outcome: 'AUTO_SKIPPED', timing: 'OUTSIDE_WINDOW' })],
      }),
    );
    expect(auto).toMatchObject({ autoSkipped: 1, skipped: 0, breaksTaken: 0 });
  });

  it('counts meetings and passes pending and hourly numbers through', () => {
    const date = '2026-09-07';
    const s = summarize(
      day(date, {
        sessions: [session(date, '09:30', '18:30')],
        presence: [presence(date, 'MEETING', '15:00', '16:00', { note: 'Sprint' })],
        meetingRecords: [pastMeeting(date, '17:00', '17:30', 'Client call')],
      }),
      {
        pending: 2,
        hourly: [
          { hour: 10, activeMin: 5, availableMin: 60, breakMin: 0, meetingMin: 0, quiet: true },
          { hour: 11, activeMin: 40, availableMin: 60, breakMin: 0, meetingMin: 0, quiet: false },
        ],
      },
    );
    expect(s).toMatchObject({
      meetings: 2,
      meetingSec: 90 * 60,
      pending: 2,
      quietHours: 1,
      activeMin: 45,
    });
  });
});

function summary(over: Partial<PersonDaySummary>): PersonDaySummary {
  return {
    date: '2026-09-01',
    weekday: 2,
    workday: true,
    dayClass: 'FULL',
    startedAt: null,
    endedAt: null,
    autoClosed: false,
    lateStart: null,
    focusSec: 0,
    expectedSec: 0,
    breakSec: 0,
    meetingSec: 0,
    approvedPlusSec: 0,
    rejectedMinusSec: 0,
    pendingPlusSec: 0,
    pendingMinusSec: 0,
    breaksTaken: 0,
    skipped: 0,
    autoSkipped: 0,
    overruns: 0,
    meetings: 0,
    pending: 0,
    quietHours: 0,
    activeMin: 0,
    label: null,
    targetSec: 0,
    paidBreakSec: 0,
    unpaidBreakSec: 0,
    awayApprovedSec: 0,
    awayPendingSec: 0,
    awayRejectedSec: 0,
    awayUnexplainedSec: 0,
    unverifiedSec: 0,
    paidSec: 0,
    ...over,
  };
}

describe('monthTotals', () => {
  const days = [
    summary({
      date: '2026-09-01',
      dayClass: 'FULL',
      focusSec: 8 * H,
      expectedSec: 8 * H,
      targetSec: 8 * H,
      breakSec: 3600,
      paidBreakSec: 3000,
      unpaidBreakSec: 600,
      awayApprovedSec: 300,
      awayPendingSec: 120,
      awayRejectedSec: 60,
      skipped: 1,
      quietHours: 2,
      paidSec: 8 * H + 3000,
    }),
    summary({
      date: '2026-09-02',
      dayClass: 'HALF',
      focusSec: 4 * H,
      expectedSec: 8 * H,
      targetSec: 8 * H,
      breakSec: 1800,
      paidBreakSec: 1800,
      meetingSec: 2700,
      awayPendingSec: 600,
      lateStart: { minutes: 20 },
      unverifiedSec: 2 * H,
      paidSec: 4 * H + 1800,
    }),
    summary({
      date: '2026-09-03',
      dayClass: 'ABSENT',
      expectedSec: 8 * H,
      targetSec: 8 * H,
      autoSkipped: 2,
      pending: 2,
    }),
    summary({
      date: '2026-09-06',
      workday: false,
      dayClass: 'EXTRA',
      focusSec: 2 * H,
      overruns: 1,
      quietHours: 1,
    }),
    summary({ date: '2026-09-07', workday: false, dayClass: 'OFF' }),
    summary({
      date: '2026-09-08',
      dayClass: 'FULL',
      focusSec: 7 * H,
      expectedSec: 8 * H,
      targetSec: 8 * H,
      approvedPlusSec: 600,
      rejectedMinusSec: 900,
      meetings: 3,
      quietHours: 1,
    }),
    // A future working day: no expected time yet, but its target counts for the month.
    summary({ date: '2026-10-01', dayClass: 'UPCOMING', targetSec: 8 * H }),
  ];

  it('every number is the sum or count of its days', () => {
    const t = monthTotals(days, '2026-09-30', 4);
    expect(t).toEqual({
      workdays: 4,
      full: 2,
      half: 1,
      absent: 1,
      off: 1,
      extra: 1,
      focusSec: 21 * H,
      expectedSec: 32 * H,
      avgFocusSec: Math.round((19 * H) / 4),
      lateStarts: 1,
      skipped: 1,
      autoSkipped: 2,
      overruns: 1,
      meetings: 3,
      approvedPlusSec: 600,
      rejectedMinusSec: 900,
      pending: 2,
      quietHours: 4,
      needsALook: true,
      // 4.0: sums of the days.
      targetSec: 40 * H,
      breakSec: 5400,
      meetingSec: 2700,
      paidBreakSec: 4800,
      unpaidBreakSec: 600,
      awayApprovedSec: 300,
      awayPendingSec: 720,
      unverifiedSec: 2 * H,
      paidSec: 12 * H + 4800,
    });
  });

  it('a snapshot day or total from before paidSec existed: paid = focus + paid breaks, unverified 0', () => {
    const old = { ...days[0] } as Partial<PersonDaySummary>;
    delete old.paidSec;
    delete old.unverifiedSec;
    const totals = monthTotals(days, '2026-09-30', 4) as Partial<MonthTotals>;
    delete totals.paidSec;
    delete totals.unverifiedSec;
    const filled = withPayrollFields({
      person: {
        id: 'a',
        name: 'A',
        email: 'a@x',
        role: 'USER',
        department: null,
        designation: null,
        managerId: null,
        managerName: null,
      },
      month: '2026-09',
      locked: true,
      generatedAt: '2026-10-01T00:00:00.000Z',
      totals: totals as MonthTotals,
      days: [old as PersonDaySummary],
      heatmap: [],
    });
    expect(filled.days[0]).toMatchObject({ paidSec: 8 * H + 3000, unverifiedSec: 0 });
    expect(filled.totals).toMatchObject({ paidSec: 21 * H + 4800, unverifiedSec: 0 });
    // A team over such rows still adds up (missing keys count as 0, never NaN).
    const team = teamTotals([{ totals: totals as MonthTotals, days }], '2026-09-30');
    expect(team.paidSec).toBe(0);
    expect(team.unverifiedSec).toBe(0);
  });

  it('needs a look only at the flag; workdays stop at today', () => {
    expect(monthTotals(days, '2026-09-30', 5).needsALook).toBe(false);
    expect(monthTotals(days, '2026-09-02', 5).workdays).toBe(2);
  });

  it('an empty month is all zeros', () => {
    expect(emptyTotals()).toMatchObject({
      workdays: 0,
      focusSec: 0,
      avgFocusSec: 0,
      needsALook: false,
    });
  });
});

describe('teamTotals', () => {
  it('sums the rows, averages focus over all their working days, and needs a look if anyone does', () => {
    const a = [
      summary({
        date: '2026-09-01',
        focusSec: 8 * H,
        expectedSec: 8 * H,
        quietHours: 5,
        targetSec: 8 * H,
        paidBreakSec: 600,
      }),
      summary({
        date: '2026-09-02',
        focusSec: 6 * H,
        expectedSec: 8 * H,
        dayClass: 'HALF',
        targetSec: 8 * H,
        awayPendingSec: 60,
      }),
    ];
    const b = [
      summary({
        date: '2026-09-01',
        focusSec: 4 * H,
        expectedSec: 8 * H,
        dayClass: 'HALF',
        pending: 1,
        targetSec: 7.5 * H,
        paidBreakSec: 300,
        unpaidBreakSec: 120,
        awayApprovedSec: 900,
      }),
    ];
    const rows = [
      { totals: monthTotals(a, '2026-09-30', 4), days: a },
      { totals: monthTotals(b, '2026-09-30', 4), days: b },
    ];
    const t = teamTotals(rows, '2026-09-30');
    expect(t).toMatchObject({
      people: 2,
      workdays: 3,
      full: 1,
      half: 2,
      focusSec: 18 * H,
      expectedSec: 24 * H,
      avgFocusSec: 6 * H,
      pending: 1,
      quietHours: 5,
      needsALook: true,
      targetSec: 23.5 * H,
      paidBreakSec: 900,
      unpaidBreakSec: 120,
      awayApprovedSec: 900,
      awayPendingSec: 60,
    });
    expect(teamTotals([], '2026-09-30')).toMatchObject({
      people: 0,
      avgFocusSec: 0,
      needsALook: false,
    });
  });
});

describe('buildTimeline', () => {
  it('splits the day into work, breaks, meetings and the gap between sessions', () => {
    const date = '2026-09-07';
    const d = day(date, {
      sessions: [session(date, '09:30', '13:00'), session(date, '14:00', '18:30')],
      presence: [
        presence(date, 'BREAK', '11:00', '11:15', { id: 'p1' }),
        presence(date, 'MEETING', '15:00', '16:00', { id: 'p2', note: 'Sprint' }),
      ],
      breakRecords: [breakRow(date, { presenceSessionId: 'p1' })],
      meetingRecords: [pastMeeting(date, '17:00', '17:30', 'Client call')],
    });
    const t = buildTimeline(d, NOW).map((s) => [s.kind, s.startedAt, s.endedAt, s.label]);
    const iso = (hm: string) => at(date, hm).toISOString();
    expect(t).toEqual([
      ['WORK', iso('09:30'), iso('11:00'), 'Working'],
      ['BREAK', iso('11:00'), iso('11:15'), 'Morning break'],
      ['WORK', iso('11:15'), iso('13:00'), 'Working'],
      ['OFF', iso('13:00'), iso('14:00'), 'Off'],
      ['WORK', iso('14:00'), iso('15:00'), 'Working'],
      ['MEETING', iso('15:00'), iso('16:00'), 'Meeting: Sprint'],
      ['WORK', iso('16:00'), iso('17:00'), 'Working'],
      ['MEETING', iso('17:00'), iso('17:30'), 'Meeting: Client call'],
      ['WORK', iso('17:30'), iso('18:30'), 'Working'],
    ]);
  });

  it('runs an open session to now and keeps a break that started before the day in bounds', () => {
    const date = '2026-09-30';
    const now = at(date, '12:00');
    const d = day(date, {
      sessions: [session(date, '09:30', null)],
      presence: [presence(date, 'LUNCH', '11:30', null)],
    });
    const t = buildTimeline(d, now);
    expect(t.map((s) => s.kind)).toEqual(['WORK', 'LUNCH']);
    expect(t[1]).toMatchObject({ label: 'Lunch', endedAt: now.toISOString() });
    expect(buildTimeline(day(date), now)).toEqual([]);
  });
});

describe('monthDates and monthRangeProblem', () => {
  it('lists every day of the month', () => {
    expect(monthDates('2026-09')).toHaveLength(30);
    expect(monthDates('2026-10')[30]).toBe('2026-10-31');
    expect(monthDates('2026-02')).toHaveLength(28);
    expect(monthDates('2028-02')).toHaveLength(29);
    expect(monthDates('2026-09')[0]).toBe('2026-09-01');
  });

  it('allows the earliest session month to the current month', () => {
    expect(monthRangeProblem('2026-11', '2026-10', '2026-09-03')).toMatch(/not happened/);
    expect(monthRangeProblem('2026-08', '2026-10', '2026-09-03')).toMatch(/before 2026-09/);
    expect(monthRangeProblem('2026-09', '2026-10', '2026-09-03')).toBeNull();
    expect(monthRangeProblem('2026-10', '2026-10', '2026-09-03')).toBeNull();
    // No sessions yet: only the current month.
    expect(monthRangeProblem('2026-10', '2026-10', null)).toBeNull();
    expect(monthRangeProblem('2026-09', '2026-10', null)).toMatch(/before 2026-10/);
  });
});
