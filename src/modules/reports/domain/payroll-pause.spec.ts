import { monthTotals, teamTotals } from './report-builder';
import {
  inPayroll,
  integrationWasOn,
  isBiometricDay,
  PAYROLL_PAUSED_LABEL,
  payrollOf,
  payrollPartOf,
} from './payroll-pause';
import { PersonDaySummary, PersonMonthReport, PersonPayroll } from './report.types';

const H = 3600;

function day(date: string, over: Partial<PersonDaySummary> = {}): PersonDaySummary {
  return {
    date,
    weekday: 1,
    workday: true,
    dayClass: 'FULL',
    startedAt: `${date}T04:00:00.000Z`,
    endedAt: `${date}T13:00:00.000Z`,
    autoClosed: false,
    lateStart: null,
    focusSec: 8 * H,
    expectedSec: 8 * H,
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
    // 4.0's day figures.
    label: null,
    targetSec: 8 * H,
    paidBreakSec: 0,
    unpaidBreakSec: 0,
    awayApprovedSec: 0,
    awayPendingSec: 0,
    awayRejectedSec: 0,
    awayUnexplainedSec: 0,
    unverifiedSec: 0,
    paidSec: 8 * H,
    ...over,
  };
}
/** 4.0: a paused day carries no paid time (zero, as summarizeDay gives it). */
const off = (date: string): PersonDaySummary => ({
  ...day(date),
  paidSec: 0,
  paidBreakSec: 0,
  payrollPaused: true,
});

describe('the label', () => {
  it('reads exactly as the brief says', () => {
    expect(PAYROLL_PAUSED_LABEL).toBe('Payroll paused · biometric integration pending');
  });
});

describe('integrationWasOn', () => {
  it('never on: every day is paused', () => {
    expect(integrationWasOn([], '2026-11-05')).toBe(false);
  });

  it('on from a day: that whole day counts, earlier days do not', () => {
    const periods = [{ fromDate: '2026-11-05', toDate: null }];
    expect(integrationWasOn(periods, '2026-11-04')).toBe(false);
    expect(integrationWasOn(periods, '2026-11-05')).toBe(true);
    expect(integrationWasOn(periods, '2026-12-01')).toBe(true);
  });

  it('switched off: the day it went off still counts, later ones do not', () => {
    const periods = [{ fromDate: '2026-11-05', toDate: '2026-11-10' }];
    expect(integrationWasOn(periods, '2026-11-10')).toBe(true);
    expect(integrationWasOn(periods, '2026-11-11')).toBe(false);
  });

  it('several periods, with a gap between', () => {
    const periods = [
      { fromDate: '2026-09-01', toDate: '2026-09-10' },
      { fromDate: '2026-10-01', toDate: null },
    ];
    expect(integrationWasOn(periods, '2026-09-05')).toBe(true);
    expect(integrationWasOn(periods, '2026-09-20')).toBe(false);
    expect(integrationWasOn(periods, '2026-10-20')).toBe(true);
  });
});

describe('isBiometricDay', () => {
  const none: { source: string }[] = [];

  it('agent staff never', () => {
    expect(isBiometricDay({ attendanceSource: 'AGENT' }, '2026-11-05', none)).toBe(false);
    expect(isBiometricDay({}, '2026-11-05', [{ source: 'AGENT' }])).toBe(false);
  });

  it('biometric staff from the day their source changed', () => {
    const p = { attendanceSource: 'BIOMETRIC' as const, attendanceSourceFrom: '2026-11-03' };
    expect(isBiometricDay(p, '2026-11-02', [{ source: 'AGENT' }])).toBe(false);
    expect(isBiometricDay(p, '2026-11-03', none)).toBe(true);
    expect(isBiometricDay({ attendanceSource: 'BIOMETRIC' }, '2026-01-01', none)).toBe(true);
  });

  it('someone moved back to the agent: their days of punches, or on the phone, still are', () => {
    const p = { attendanceSource: 'AGENT' as const, attendanceSourceFrom: '2026-11-03' };
    expect(isBiometricDay(p, '2026-11-02', [{ source: 'BIOMETRIC' }])).toBe(true);
    expect(isBiometricDay(p, '2026-11-02', [{ source: 'MOBILE_WFH' }])).toBe(true);
    expect(isBiometricDay(p, '2026-11-02', none)).toBe(false);
    expect(isBiometricDay(p, '2026-11-03', [{ source: 'AGENT' }])).toBe(false);
  });

  describe('moved back to the agent: the source in force on that date', () => {
    const back = { attendanceSource: 'AGENT' as const, attendanceSourceFrom: '2026-11-05' };
    const stretch = [{ fromDate: '2026-10-01', toDate: '2026-11-04' }];

    it('a day of the stretch stays biometric with no punch at all, on any day of the week', () => {
      expect(isBiometricDay(back, '2026-10-20', none, stretch)).toBe(true);
      expect(isBiometricDay(back, '2026-10-25', none, stretch)).toBe(true);
      expect(isBiometricDay(back, '2026-11-04', none, stretch)).toBe(true);
    });

    it('before the stretch and from the move on, they are not', () => {
      expect(isBiometricDay(back, '2026-09-30', none, stretch)).toBe(false);
      expect(isBiometricDay(back, '2026-11-05', none, stretch)).toBe(false);
      expect(isBiometricDay(back, '2026-11-06', [{ source: 'AGENT' }], stretch)).toBe(false);
    });

    it('a stretch with no recorded start ran from the beginning', () => {
      const open = [{ fromDate: null, toDate: '2026-11-04' }];
      expect(isBiometricDay(back, '2025-01-01', none, open)).toBe(true);
    });

    it('moved onto biometric again: the earlier stretch still holds', () => {
      const again = { attendanceSource: 'BIOMETRIC' as const, attendanceSourceFrom: '2026-11-08' };
      expect(isBiometricDay(again, '2026-10-20', none, stretch)).toBe(true);
      expect(isBiometricDay(again, '2026-11-06', none, stretch)).toBe(false);
      expect(isBiometricDay(again, '2026-11-08', none, stretch)).toBe(true);
    });

    it('a move made before stretches were kept: its days of punches still are', () => {
      expect(isBiometricDay(back, '2026-10-20', [{ source: 'BIOMETRIC' }])).toBe(true);
      expect(
        isBiometricDay(back, '2026-10-20', [{ source: 'AGENT' }, { source: 'BIOMETRIC' }]),
      ).toBe(true);
    });
  });

  describe('the day of the move', () => {
    const back = { attendanceSource: 'AGENT' as const, attendanceSourceFrom: '2026-11-10' };

    it('a punch, then the agent: calculated, agent hours and all', () => {
      expect(
        isBiometricDay(back, '2026-11-10', [{ source: 'BIOMETRIC' }, { source: 'AGENT' }]),
      ).toBe(false);
    });

    it('a whole day of punches, moved at the end of it: still a biometric day', () => {
      expect(isBiometricDay(back, '2026-11-10', [{ source: 'BIOMETRIC' }])).toBe(true);
      expect(isBiometricDay(back, '2026-11-10', [{ source: 'MOBILE_WFH' }])).toBe(true);
    });

    it('nothing yet that day: an agent day', () => {
      expect(isBiometricDay(back, '2026-11-10', none)).toBe(false);
    });
  });
});

describe('payrollOf', () => {
  const today = '2026-09-30';

  it('no paused day: nothing at all, so the report is what it always was', () => {
    expect(payrollOf([day('2026-09-01'), day('2026-09-02')], today, 4)).toBeNull();
  });

  it('every day so far paused: left out, with the label', () => {
    const p = payrollOf([off('2026-09-01'), off('2026-09-02')], today, 4);
    expect(p).toMatchObject({
      paused: true,
      label: PAYROLL_PAUSED_LABEL,
      pausedDays: 2,
      pausedFrom: '2026-09-01',
      pausedTo: '2026-09-02',
    });
    expect(p?.totals).toMatchObject({ focusSec: 0, paidSec: 0, workdays: 0, full: 0 });
  });

  it('switched on part way: only the days from then on count', () => {
    const p = payrollOf([off('2026-09-01'), off('2026-09-02'), day('2026-09-03')], today, 4);
    expect(p).toMatchObject({ paused: false, pausedDays: 2, pausedTo: '2026-09-02' });
    expect(p?.totals).toMatchObject({ focusSec: 8 * H, paidSec: 8 * H, workdays: 1, full: 1 });
  });

  it('someone who joined part way through has nothing to count before it: left out', () => {
    const beforeJoining = day('2026-09-01', {
      workday: false,
      dayClass: 'OFF',
      startedAt: null,
      endedAt: null,
      focusSec: 0,
      expectedSec: 0,
    });
    const p = payrollOf([beforeJoining, off('2026-09-02')], today, 4);
    expect(p).toMatchObject({ paused: true, pausedDays: 1, pausedFrom: '2026-09-02' });
  });

  it('days still ahead are not counted against anyone', () => {
    const p = payrollOf([off('2026-09-29'), off('2026-09-30'), off('2026-10-01')], today, 4);
    expect(p).toMatchObject({ paused: true, pausedDays: 2, pausedTo: '2026-09-30' });
  });

  describe('weekly offs and holidays', () => {
    const offDay = (date: string, kind: 'WEEKLY_OFF' | 'HOLIDAY' = 'WEEKLY_OFF') => ({
      ...off(date),
      workday: false,
      dayClass: 'OFF' as const,
      startedAt: null,
      endedAt: null,
      focusSec: 0,
      expectedSec: 0,
      dayOff: { kind, name: null },
    });

    it('with every working day calculated, nothing is left out: no standing at all', () => {
      expect(payrollOf([offDay('2026-09-06'), day('2026-09-07')], today, 4)).toBeNull();
      expect(payrollOf([day('2026-09-05'), offDay('2026-09-06', 'HOLIDAY')], today, 4)).toBeNull();
    });

    it('they are not counted among the days left out', () => {
      const p = payrollOf(
        [off('2026-09-05'), offDay('2026-09-06'), off('2026-09-07'), offDay('2026-09-13')],
        today,
        4,
      );
      expect(p).toMatchObject({
        paused: true,
        pausedDays: 2,
        pausedFrom: '2026-09-05',
        pausedTo: '2026-09-07',
      });
    });

    it('nor at either end of a resumed stretch', () => {
      const p = payrollOf(
        [offDay('2026-09-06'), off('2026-09-07'), offDay('2026-09-13'), day('2026-09-14')],
        today,
        4,
      );
      expect(p).toMatchObject({
        paused: false,
        pausedDays: 1,
        pausedFrom: '2026-09-07',
        pausedTo: '2026-09-07',
      });
    });

    it('a worked day off is a day left out', () => {
      const worked = {
        ...offDay('2026-09-06'),
        startedAt: '2026-09-06T04:00:00.000Z',
        focusSec: H,
      };
      expect(payrollOf([worked, day('2026-09-07')], today, 4)).toMatchObject({
        paused: false,
        pausedDays: 1,
      });
    });

    it('only off days so far and nothing calculated: still labelled, not on payroll', () => {
      const p = payrollOf([offDay('2026-09-06'), off('2026-09-07')], '2026-09-06', 4);
      expect(p).toMatchObject({ paused: true, pausedDays: 1, pausedFrom: '2026-09-06' });
      expect(inPayroll([{ payroll: p as PersonPayroll }])).toEqual([]);
    });
  });
});

describe('a month with biometric staff in it', () => {
  const today = '2026-09-30';
  const report = (id: string, days: PersonDaySummary[]): PersonMonthReport => {
    const payroll = payrollOf(days, today, 4);
    return {
      person: {
        id,
        name: id,
        email: `${id}@x.test`,
        role: 'USER',
        department: null,
        designation: null,
        managerId: null,
        managerName: null,
      },
      month: '2026-09',
      locked: false,
      generatedAt: '2026-10-01T00:00:00.000Z',
      totals: monthTotals(days, today, 4),
      days,
      heatmap: [],
      ...(payroll ? { payroll } : {}),
    };
  };
  const agentDays = [day('2026-09-01'), day('2026-09-02', { focusSec: 4 * H, dayClass: 'HALF' })];
  const team = (persons: PersonMonthReport[]) =>
    teamTotals(inPayroll(persons).map(payrollPartOf), today);

  it('payroll totals are exactly those of agent staff alone, before and after', () => {
    const before = team([report('agent', agentDays)]);
    const after = team([
      report('agent', agentDays),
      report('paused', [off('2026-09-01'), off('2026-09-02')]),
    ]);
    expect(after).toEqual(before);
    expect(after).toMatchObject({ people: 1, focusSec: 12 * H, paidSec: 16 * H, workdays: 2 });
  });

  it('agent staff themselves carry nothing new', () => {
    const r = report('agent', agentDays);
    expect(r).not.toHaveProperty('payroll');
    expect(payrollPartOf(r)).toEqual({ totals: r.totals, days: r.days });
  });

  it('tracking stays: a paused person still shows every day and their focus time', () => {
    const r = report('paused', [off('2026-09-01'), off('2026-09-02')]);
    expect(r.totals).toMatchObject({ focusSec: 16 * H, workdays: 2, full: 2, paidSec: 0 });
    expect(r.days).toHaveLength(2);
    expect(inPayroll([r])).toEqual([]);
  });

  it('switching on resumes from that day; the days before it stay paused', () => {
    const periods = [{ fromDate: '2026-09-03', toDate: null }];
    const r = report(
      'resumed',
      ['2026-09-01', '2026-09-02', '2026-09-03'].map((date) =>
        integrationWasOn(periods, date) ? day(date) : off(date),
      ),
    );
    expect(inPayroll([r])).toHaveLength(1);
    expect(payrollPartOf(r).days.map((d) => d.date)).toEqual(['2026-09-03']);
    expect(team([r])).toMatchObject({ people: 1, focusSec: 8 * H, workdays: 1 });
  });
});
