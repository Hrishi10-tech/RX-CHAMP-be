import {
  calendarSource,
  dayLabel,
  isWorkingDay,
  OrgCalendar,
  saturdayOrdinal,
  saturdayWorked,
  WorkWeek,
} from './calendar.rules';

/**
 * 3.5 on 4.0's organisation calendar: Saturday rules, a department's and a person's
 * own week, and holidays for some departments. Without a person, every answer is
 * 4.0's.
 */
// November 2026: Saturdays are the 7th, 14th, 21st and 28th.
const SAT_1 = '2026-11-07';
const SAT_2 = '2026-11-14';
const SAT_3 = '2026-11-21';
const SAT_4 = '2026-11-28';
const MONDAY = '2026-11-09';
const SUNDAY = '2026-11-08';

const org = (over: Partial<OrgCalendar> = {}): OrgCalendar => ({
  weekPattern: [1, 2, 3, 4, 5, 6],
  overrides: new Map(),
  ...over,
});
const week = (
  workDays: number[],
  saturdays: WorkWeek['saturdays'] = 'EVERY',
  anchor: string | null = null,
): WorkWeek => ({
  workDays,
  saturdays,
  saturdayAnchor: anchor,
});

describe('Saturday rules', () => {
  it('knows which Saturday of the month it is', () => {
    expect([SAT_1, SAT_2, SAT_3, SAT_4].map(saturdayOrdinal)).toEqual([1, 2, 3, 4]);
  });

  it('works out each rule', () => {
    const sats = [SAT_1, SAT_2, SAT_3, SAT_4];
    expect(sats.map((d) => saturdayWorked('EVERY', null, d))).toEqual([true, true, true, true]);
    expect(sats.map((d) => saturdayWorked('NONE', null, d))).toEqual([false, false, false, false]);
    expect(sats.map((d) => saturdayWorked('OFF_2_4', null, d))).toEqual([true, false, true, false]);
    expect(sats.map((d) => saturdayWorked('OFF_1_3', null, d))).toEqual([false, true, false, true]);
    expect(sats.map((d) => saturdayWorked('ALTERNATE', SAT_1, d))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    // Before the anchor too.
    expect(saturdayWorked('ALTERNATE', SAT_3, SAT_1)).toBe(true);
  });
});

describe('the organisation calendar with people (3.5)', () => {
  it('asks nothing new without a person: 4.0 answers unchanged', () => {
    const cal = org();
    expect(isWorkingDay(cal, SAT_2)).toBe(true);
    expect(isWorkingDay(cal, SUNDAY)).toBe(false);
  });

  it("applies the organisation's Saturday rule to Saturdays in its pattern", () => {
    const cal = org({ saturdays: 'OFF_2_4' });
    expect(isWorkingDay(cal, SAT_1)).toBe(true);
    expect(isWorkingDay(cal, SAT_2)).toBe(false);
    // A pattern without Saturday stays without it, whatever the rule.
    expect(isWorkingDay(org({ weekPattern: [1, 2, 3, 4, 5], saturdays: 'EVERY' }), SAT_1)).toBe(
      false,
    );
  });

  it("a person's own week beats their department's, which beats the organisation's", () => {
    const cal = org({
      departments: new Map([['d1', week([1, 2, 3, 4, 5, 6], 'NONE')]]),
      people: new Map([['u-own', week([2, 3, 4, 5, 6, 7])]]),
    });
    const deptPerson = { id: 'u1', departmentId: 'd1' };
    const ownPerson = { id: 'u-own', departmentId: 'd1' };
    expect(isWorkingDay(cal, SAT_1, deptPerson)).toBe(false);
    expect(calendarSource(cal, SAT_1, deptPerson)).toBe('DEPARTMENT');
    expect(isWorkingDay(cal, SUNDAY, ownPerson)).toBe(true);
    expect(isWorkingDay(cal, MONDAY, ownPerson)).toBe(false);
    expect(calendarSource(cal, MONDAY, ownPerson)).toBe('PERSON');
    expect(calendarSource(cal, MONDAY, { id: 'x', departmentId: 'd9' })).toBe('ORGANISATION');
  });

  it('a day set on the calendar beats every week; a department holiday only its departments', () => {
    const cal = org({
      overrides: new Map([
        [MONDAY, { isWorking: false, label: 'Onam', departmentIds: ['d1'] }],
        [SUNDAY, { isWorking: true, label: 'Stock take', departmentIds: [] }],
      ]),
      people: new Map([['u-own', week([1, 2, 3, 4, 5])]]),
    });
    expect(isWorkingDay(cal, MONDAY, { id: 'u1', departmentId: 'd1' })).toBe(false);
    expect(dayLabel(cal, MONDAY, { id: 'u1', departmentId: 'd1' })).toBe('Onam');
    // Not their department: the week decides.
    expect(isWorkingDay(cal, MONDAY, { id: 'u2', departmentId: 'd2' })).toBe(true);
    expect(dayLabel(cal, MONDAY, { id: 'u2', departmentId: 'd2' })).toBeNull();
    // Nobody named: a department holiday is not the organisation's.
    expect(isWorkingDay(cal, MONDAY)).toBe(true);
    // An organisation-wide override beats a person's own week.
    expect(isWorkingDay(cal, SUNDAY, { id: 'u-own', departmentId: null })).toBe(true);
    expect(calendarSource(cal, SUNDAY, { id: 'u-own' })).toBe('OVERRIDE');
  });
});
