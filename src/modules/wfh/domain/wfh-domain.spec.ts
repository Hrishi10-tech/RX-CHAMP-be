import {
  capSecOf,
  checkWfhRequest,
  priceWfhDays,
  scheduleCovers,
  scheduleDates,
  scheduleLabel,
  weekOfMonth,
  WfhScheduleRecord,
} from './wfh';
import { applyWfhPatch, DEFAULT_WFH_POLICY, wfhPolicyFromStored } from './wfh-policy';

const at = new Date('2026-11-01T00:00:00Z');
const schedule = (over: Partial<WfhScheduleRecord> = {}): WfhScheduleRecord => ({
  id: 's1',
  userId: 'u1',
  weekdays: [3],
  weeks: [],
  kind: 'FULL_DAY',
  part: null,
  fromDate: '2026-11-01',
  toDate: null,
  skipDates: [],
  note: '',
  createdById: 'm1',
  updatedById: null,
  createdAt: at,
  updatedAt: at,
  ...over,
});

describe('work-from-home schedules', () => {
  it('every Wednesday from the first day, until the last', () => {
    expect(scheduleDates(schedule(), '2026-11-01', '2026-11-30')).toEqual([
      '2026-11-04',
      '2026-11-11',
      '2026-11-18',
      '2026-11-25',
    ]);
    expect(scheduleDates(schedule({ toDate: '2026-11-15' }), '2026-11-01', '2026-11-30')).toEqual([
      '2026-11-04',
      '2026-11-11',
    ]);
  });

  it('only some weeks of the month: the 1st and 3rd Friday', () => {
    const s = schedule({ weekdays: [5], weeks: [1, 3] });
    expect(scheduleDates(s, '2026-11-01', '2026-11-30')).toEqual(['2026-11-06', '2026-11-20']);
    expect(weekOfMonth('2026-11-06')).toBe(1);
    expect(weekOfMonth('2026-11-29')).toBe(5);
  });

  it('a day left out is not covered', () => {
    const s = schedule({ skipDates: ['2026-11-11'] });
    expect(scheduleCovers(s, '2026-11-11')).toBe(false);
    expect(scheduleCovers(s, '2026-11-18')).toBe(true);
  });

  it('reads as a sentence', () => {
    expect(scheduleLabel(schedule())).toBe('Every Wednesday, full day');
    expect(
      scheduleLabel(
        schedule({ weekdays: [1, 5], weeks: [2, 4], kind: 'HALF_DAY', part: 'SECOND_HALF' }),
      ),
    ).toBe('2nd and 4th Monday and Friday, half day (second half)');
  });
});

describe('the credit cap', () => {
  it('is the basis times the share of the day', () => {
    expect(capSecOf(9 * 3600, 0b1111)).toBe(9 * 3600);
    expect(capSecOf(9 * 3600, 0b0011)).toBe(4.5 * 3600);
    expect(capSecOf(9 * 3600, 0b1000)).toBe(2.25 * 3600);
    expect(capSecOf(9 * 3600, 0)).toBe(0);
  });
});

describe('a request', () => {
  const policy = { ...DEFAULT_WFH_POLICY };
  const base = { kind: 'FULL_DAY', startDate: '2026-11-06', reason: 'Plumber visit' };

  it('needs the notice: one day ahead by default', () => {
    expect(checkWfhRequest(base, { today: '2026-11-05', policy }).ok).toBe(true);
    const same = checkWfhRequest(
      { ...base, startDate: '2026-11-05' },
      { today: '2026-11-05', policy },
    );
    expect(same).toMatchObject({ ok: false, code: 'NOTICE_TOO_SHORT' });
    const zero = checkWfhRequest(
      { ...base, startDate: '2026-11-05' },
      { today: '2026-11-05', policy: { ...policy, noticeDays: 0 } },
    );
    expect(zero.ok).toBe(true);
  });

  it('a half day is one day and names its half', () => {
    expect(
      checkWfhRequest({ ...base, kind: 'HALF_DAY' }, { today: '2026-11-01', policy }),
    ).toMatchObject({ ok: false, field: 'part' });
    expect(
      checkWfhRequest(
        { ...base, kind: 'HALF_DAY', part: 'FIRST_HALF', endDate: '2026-11-07' },
        { today: '2026-11-01', policy },
      ),
    ).toMatchObject({ ok: false, field: 'endDate' });
  });

  it('covers working days only, and skips full days of leave', () => {
    const days = [
      { date: '2026-11-06', workday: true, offLabel: null, leaveMask: 0, scheduledMask: 0 },
      {
        date: '2026-11-07',
        workday: false,
        offLabel: 'Weekly day off',
        leaveMask: 0,
        scheduledMask: 0,
      },
      { date: '2026-11-09', workday: true, offLabel: null, leaveMask: 0b1111, scheduledMask: 0 },
    ];
    const priced = priceWfhDays('FULL_DAY', null, days);
    expect(priced.covered.map((d) => d.date)).toEqual(['2026-11-06']);
    expect(priced.skipped).toEqual([
      { date: '2026-11-07', why: 'Weekly day off' },
      { date: '2026-11-09', why: 'On leave' },
    ]);
  });
});

describe('the policy', () => {
  it('falls back to the defaults for anything unreadable', () => {
    expect(wfhPolicyFromStored({ noticeDays: -3, approver: 'NOBODY' })).toEqual(DEFAULT_WFH_POLICY);
  });

  it('only a Super Admin changes who approves', () => {
    expect(
      applyWfhPatch(DEFAULT_WFH_POLICY, { approver: 'SUPER_ADMIN' }, { mayRoute: false }),
    ).toMatchObject({
      ok: false,
      field: 'approver',
    });
    expect(
      applyWfhPatch(DEFAULT_WFH_POLICY, { approver: 'SUPER_ADMIN' }, { mayRoute: true }),
    ).toMatchObject({
      ok: true,
      changed: ['approver'],
    });
  });

  it('a monthly cap is 1 to 31 days, or none', () => {
    expect(applyWfhPatch(DEFAULT_WFH_POLICY, { maxDaysPerMonth: 0 }, { mayRoute: true }).ok).toBe(
      false,
    );
    expect(applyWfhPatch(DEFAULT_WFH_POLICY, { maxDaysPerMonth: 8 }, { mayRoute: true }).ok).toBe(
      true,
    );
    expect(
      applyWfhPatch(DEFAULT_WFH_POLICY, { maxDaysPerMonth: null }, { mayRoute: true }).ok,
    ).toBe(true);
    expect(applyWfhPatch(DEFAULT_WFH_POLICY, { nope: 1 }, { mayRoute: true }).ok).toBe(false);
  });
});
