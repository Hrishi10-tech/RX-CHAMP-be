import { dayClassOf, expectedSecOf, isWorkdayFor, lateStartOf } from './attendance';
import { activeMinOf, buildHourly, quietHoursOf } from './hourly';

const ist = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 13, h, m) - 330 * 60_000);
};

const general = {
  start: '09:30',
  end: '18:30',
  workDays: [1, 2, 3, 4, 5, 6],
  breaks: [
    { enabled: true, durationMin: 15 },
    { enabled: true, durationMin: 30 },
    { enabled: true, durationMin: 15 },
  ],
};

describe('expected time', () => {
  it('is the shift minus its enabled breaks (General = 8h)', () => {
    expect(expectedSecOf(general)).toBe(8 * 3600);
    expect(
      expectedSecOf({
        ...general,
        breaks: [
          { enabled: false, durationMin: 60 },
          { enabled: true, durationMin: 30 },
        ],
      }),
    ).toBe(8.5 * 3600);
  });

  it('handles an overnight shift and no shift', () => {
    expect(expectedSecOf({ ...general, start: '22:00', end: '06:00', breaks: [] })).toBe(8 * 3600);
    expect(expectedSecOf(null)).toBe(8 * 3600);
  });

  it('knows working days, Monday to Saturday without a shift', () => {
    expect(isWorkdayFor(general, '2026-10-13')).toBe(true);
    expect(isWorkdayFor(general, '2026-10-18')).toBe(false); // Sunday
    expect(isWorkdayFor(null, '2026-10-17')).toBe(true); // Saturday
    expect(isWorkdayFor({ workDays: [7] }, '2026-10-18')).toBe(true);
  });
});

describe('day class', () => {
  const base = {
    date: '2026-10-12',
    today: '2026-10-13',
    workday: true,
    spanSec: 1,
    expectedSec: 8 * 3600,
    fullDayPct: 80,
    halfDayPct: 40,
  };

  it('is FULL at exactly 80% and HALF one second below', () => {
    expect(dayClassOf({ ...base, focusSec: 23040 })).toBe('FULL');
    expect(dayClassOf({ ...base, focusSec: 23039 })).toBe('HALF');
  });

  it('is HALF at exactly 40% and ABSENT one second below', () => {
    expect(dayClassOf({ ...base, focusSec: 11520 })).toBe('HALF');
    expect(dayClassOf({ ...base, focusSec: 11519 })).toBe('ABSENT');
    expect(dayClassOf({ ...base, focusSec: 0, spanSec: 0 })).toBe('ABSENT');
  });

  it('follows the settings', () => {
    expect(dayClassOf({ ...base, focusSec: 20000, fullDayPct: 60 })).toBe('FULL');
  });

  it('is OFF or EXTRA on a day off, IN_PROGRESS today, UPCOMING later', () => {
    expect(dayClassOf({ ...base, workday: false, focusSec: 0, spanSec: 0 })).toBe('OFF');
    expect(dayClassOf({ ...base, workday: false, focusSec: 3600, spanSec: 3600 })).toBe('EXTRA');
    expect(dayClassOf({ ...base, date: '2026-10-13', focusSec: 0 })).toBe('IN_PROGRESS');
    expect(dayClassOf({ ...base, date: '2026-10-14', focusSec: 0 })).toBe('UPCOMING');
  });
});

describe('late start', () => {
  it('is late only past the grace, in whole minutes', () => {
    expect(lateStartOf(ist('09:40'), ist('09:30'), 10)).toBeNull();
    expect(lateStartOf(new Date(ist('09:40').getTime() + 59_000), ist('09:30'), 10)).toBeNull();
    expect(lateStartOf(ist('09:41'), ist('09:30'), 10)).toEqual({ minutes: 11 });
    expect(lateStartOf(ist('09:00'), ist('09:30'), 10)).toBeNull();
    expect(lateStartOf(ist('09:35'), ist('09:30'), 0)).toEqual({ minutes: 5 });
    expect(lateStartOf(null, ist('09:30'), 10)).toBeNull();
    expect(lateStartOf(ist('10:30'), null, 10)).toBeNull();
  });
});

describe('hourly activity', () => {
  const hourOf = (h: number) => ({
    start: ist(`${h}:00`).getTime(),
    end: ist(`${h + 1}:00`).getTime(),
  });
  const at = (hm: string) => ist(hm).getTime();

  it('finds quiet hours: 50+ available minutes, no break or meeting, few active minutes', () => {
    const active = Array(24).fill(0);
    active[10] = 30 * 60; // busy
    active[11] = 5 * 60; // quiet
    active[12] = 5 * 60; // has a meeting
    active[13] = 5 * 60; // lunch
    active[14] = 5 * 60; // only 40 available minutes (session ends 14:40)
    const hours = buildHourly({
      dateKey: '2026-10-13',
      tz: 'Asia/Kolkata',
      work: [{ start: at('09:30'), end: at('14:40') }],
      breaks: [{ start: at('13:00'), end: at('13:30') }],
      meetings: [{ start: at('12:10'), end: at('12:20') }],
      activeSecByHour: active,
      quietHourActiveMin: 20,
    });
    expect(hours).toHaveLength(24);
    expect(hours[9]).toMatchObject({ availableMin: 30, quiet: false });
    expect(hours[10]).toMatchObject({ activeMin: 30, availableMin: 60, quiet: false });
    expect(hours[11]).toMatchObject({ activeMin: 5, availableMin: 60, quiet: true });
    expect(hours[12]).toMatchObject({ meetingMin: 10, availableMin: 50, quiet: false });
    expect(hours[13]).toMatchObject({ breakMin: 30, availableMin: 30, quiet: false });
    expect(hours[14]).toMatchObject({ availableMin: 40, quiet: false });
    expect(quietHoursOf(hours)).toBe(1);
    expect(activeMinOf(hours)).toBe(50);
    // The bucket boundaries are local hours.
    expect(hourOf(11).start).toBe(ist('11:00').getTime());
  });

  it('respects the active-minute threshold exactly', () => {
    const make = (activeMin: number) =>
      buildHourly({
        dateKey: '2026-10-13',
        tz: 'Asia/Kolkata',
        work: [{ start: at('11:00'), end: at('12:00') }],
        breaks: [],
        meetings: [],
        activeSecByHour: Object.assign(Array(24).fill(0), { 11: activeMin * 60 }),
        quietHourActiveMin: 20,
      })[11].quiet;
    expect(make(19)).toBe(true);
    expect(make(20)).toBe(false);
  });
});
