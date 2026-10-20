import {
  checkWeekPattern,
  cleanLabel,
  datesOfMonth,
  dayLabel,
  DayOverride,
  DEFAULT_WEEK_PATTERN,
  isValidDateKey,
  isValidMonth,
  isWorkingDay,
  LABEL_MAX,
  monthSummary,
  OrgCalendar,
  PATTERN_SINCE_ALWAYS,
  patternHistoryFromStored,
  patternOn,
  weekPatternFromStored,
  withPatternFrom,
} from './calendar.rules';

function cal(
  weekPattern: number[] = [...DEFAULT_WEEK_PATTERN],
  overrides: Record<string, DayOverride> = {},
): OrgCalendar {
  return { weekPattern, overrides: new Map(Object.entries(overrides)) };
}

describe('week pattern (SPEC 2.6)', () => {
  it('defaults to Monday to Saturday', () => {
    expect([...DEFAULT_WEEK_PATTERN]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(weekPatternFromStored(undefined)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(weekPatternFromStored('1,2,3')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(weekPatternFromStored({ 0: 1 })).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('reads a stored pattern: sorted, de-duplicated, invalid days dropped', () => {
    expect(weekPatternFromStored([5, 1, 3, 3, 1])).toEqual([1, 3, 5]);
    expect(weekPatternFromStored([0, 8, 2.5, '4', null, 7, 2])).toEqual([2, 7]);
    // A stored empty pattern is kept (every working day then comes from overrides).
    expect(weekPatternFromStored([])).toEqual([]);
  });

  it('validates a pattern sent by the Admin', () => {
    expect(checkWeekPattern([5, 4, 3, 2, 1, 1])).toEqual({ ok: true, days: [1, 2, 3, 4, 5] });
    expect(checkWeekPattern([7])).toEqual({ ok: true, days: [7] });
    expect(checkWeekPattern([])).toEqual({ ok: true, days: [] });
    for (const bad of [[0], [8], [1, 2.5], ['1'], [null]]) {
      expect(checkWeekPattern(bad)).toEqual({
        ok: false,
        message: 'Each weekday is a whole number from 1 (Monday) to 7 (Sunday).',
      });
    }
    for (const bad of [undefined, null, '1,2', { days: [1] }, 3]) {
      expect(checkWeekPattern(bad)).toMatchObject({
        ok: false,
        message: expect.stringContaining('list of weekdays'),
      });
    }
  });
});

describe('working days', () => {
  it('follows the pattern by ISO weekday', () => {
    const c = cal();
    expect(isWorkingDay(c, '2026-10-19')).toBe(true); // Monday
    expect(isWorkingDay(c, '2026-10-24')).toBe(true); // Saturday
    expect(isWorkingDay(c, '2026-10-25')).toBe(false); // Sunday
    const monFri = cal([1, 2, 3, 4, 5]);
    expect(isWorkingDay(monFri, '2026-10-24')).toBe(false);
  });

  it('an override wins over the pattern both ways', () => {
    const c = cal([1, 2, 3, 4, 5, 6], {
      '2026-11-09': { isWorking: false, label: 'Diwali' }, // a Monday made a holiday
      '2026-10-25': { isWorking: true, label: null }, // a Sunday made a working day
    });
    expect(isWorkingDay(c, '2026-11-09')).toBe(false);
    expect(isWorkingDay(c, '2026-10-25')).toBe(true);
    expect(dayLabel(c, '2026-11-09')).toBe('Diwali');
    expect(dayLabel(c, '2026-10-25')).toBeNull();
    expect(dayLabel(c, '2026-10-26')).toBeNull();
  });
});

describe('month summary', () => {
  it('counts working days from the pattern', () => {
    // October 2026: 31 days, 4 Sundays.
    expect(monthSummary(cal(), '2026-10')).toEqual({
      month: '2026-10',
      workingDays: 27,
      holidays: [],
    });
    expect(monthSummary(cal([1, 2, 3, 4, 5]), '2026-10').workingDays).toBe(22);
    expect(monthSummary(cal([]), '2026-10').workingDays).toBe(0);
  });

  it('a holiday on a pattern day takes a working day off and is listed', () => {
    const c = cal(undefined, {
      '2026-10-02': { isWorking: false, label: 'Gandhi Jayanti' },
      '2026-10-20': { isWorking: false, label: null },
    });
    const s = monthSummary(c, '2026-10');
    expect(s.workingDays).toBe(25);
    expect(s.holidays).toEqual([
      { date: '2026-10-02', label: 'Gandhi Jayanti' },
      { date: '2026-10-20', label: null },
    ]);
  });

  it('a labelled non-working override on a day off is listed; an unlabelled one is not', () => {
    const c = cal(undefined, {
      '2026-10-04': { isWorking: false, label: 'Founders day' }, // Sunday
      '2026-10-11': { isWorking: false, label: null }, // Sunday, nothing to say
    });
    const s = monthSummary(c, '2026-10');
    expect(s.workingDays).toBe(27);
    expect(s.holidays).toEqual([{ date: '2026-10-04', label: 'Founders day' }]);
  });

  it('a working override on a day off adds a working day and is not a holiday', () => {
    const c = cal(undefined, { '2026-10-25': { isWorking: true, label: 'Stock take' } });
    expect(monthSummary(c, '2026-10')).toEqual({ month: '2026-10', workingDays: 28, holidays: [] });
  });

  it('overrides in other months do not leak in', () => {
    const c = cal(undefined, { '2026-11-09': { isWorking: false, label: 'Diwali' } });
    expect(monthSummary(c, '2026-10')).toEqual({ month: '2026-10', workingDays: 27, holidays: [] });
    expect(monthSummary(c, '2026-11')).toEqual({
      month: '2026-11',
      workingDays: 24,
      holidays: [{ date: '2026-11-09', label: 'Diwali' }],
    });
  });
});

describe('week pattern history (effective from a date)', () => {
  const history = (...entries: [string, number[]][]) =>
    entries.map(([from, days]) => ({ from, days }));

  it('each date follows the latest pattern that started on or before it', () => {
    const c: OrgCalendar = {
      weekPattern: [1, 2, 3, 4, 5],
      patterns: history(
        [PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]],
        ['2026-10-19', [1, 2, 3, 4, 5]],
      ),
      overrides: new Map(),
    };
    expect(patternOn(c, '2026-10-18')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(patternOn(c, '2026-10-19')).toEqual([1, 2, 3, 4, 5]);
    expect(patternOn(c, '1999-01-01')).toEqual([1, 2, 3, 4, 5, 6]);
    // Saturday 17 Oct was a working day under the old pattern; Saturday 24th is not.
    expect(isWorkingDay(c, '2026-10-17')).toBe(true);
    expect(isWorkingDay(c, '2026-10-24')).toBe(false);
    // A month before the change keeps its working days; the month of the change mixes them.
    expect(monthSummary(c, '2026-09').workingDays).toBe(26);
    expect(monthSummary(c, '2026-10').workingDays).toBe(27 - 2); // Sat 24 and Sat 31 are off now
    // Overrides still win on either side of the change.
    c.overrides.set('2026-10-24', { isWorking: true, label: 'Stock take' });
    expect(isWorkingDay(c, '2026-10-24')).toBe(true);
  });

  it('without a history the single pattern applies to every date (3.x calendars)', () => {
    expect(patternOn(cal([1, 2, 3]), '2026-10-24')).toEqual([1, 2, 3]);
  });

  it('reads the stored history; the 3.x pattern is the entry since always', () => {
    expect(patternHistoryFromStored(undefined, [1, 2, 3, 4, 5])).toEqual(
      history([PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5]]),
    );
    expect(patternHistoryFromStored(undefined, undefined)).toEqual(
      history([PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]]),
    );
    expect(
      patternHistoryFromStored(
        [
          { from: '2026-11-01', days: [1, 2, 3, 4] },
          { from: '2026-10-19', days: [5, 1, 2, 3, 4, 4] },
          { from: 'nonsense', days: [1] },
          { from: '2026-02-30', days: [1] },
          { days: [1] },
          null,
          { from: '2026-12-01', days: 'Mon' },
        ],
        [1, 2, 3, 4, 5, 6],
      ),
    ).toEqual(
      history(
        [PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]],
        ['2026-10-19', [1, 2, 3, 4, 5]],
        ['2026-11-01', [1, 2, 3, 4]],
      ),
    );
    // A stored history that already starts from the beginning keeps its own first pattern.
    expect(
      patternHistoryFromStored([{ from: PATTERN_SINCE_ALWAYS, days: [1] }], [1, 2, 3]),
    ).toEqual(history([PATTERN_SINCE_ALWAYS, [1]]));
    // Nothing usable: the 3.x pattern.
    expect(patternHistoryFromStored([{ from: 'x' }], [2])).toEqual(
      history([PATTERN_SINCE_ALWAYS, [2]]),
    );
  });

  it('a new pattern applies from its date on: later entries go, earlier ones stay', () => {
    const h = history(
      [PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]],
      ['2026-09-01', [1, 2, 3, 4, 5]],
      ['2026-12-01', [1, 2, 3]],
    );
    expect(withPatternFrom(h, '2026-10-19', [1, 2, 3, 4])).toEqual(
      history(
        [PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]],
        ['2026-09-01', [1, 2, 3, 4, 5]],
        ['2026-10-19', [1, 2, 3, 4]],
      ),
    );
    // The same date again replaces that entry.
    expect(withPatternFrom(h, '2026-09-01', [7])).toEqual(
      history([PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]], ['2026-09-01', [7]]),
    );
  });

  it('the same week as the one in force adds nothing (and drops later changes)', () => {
    const h = history(
      [PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]],
      ['2026-09-01', [1, 2, 3, 4, 5]],
      ['2026-12-01', [1, 2, 3]],
    );
    expect(withPatternFrom(h, '2026-10-19', [1, 2, 3, 4, 5])).toEqual(
      history([PATTERN_SINCE_ALWAYS, [1, 2, 3, 4, 5, 6]], ['2026-09-01', [1, 2, 3, 4, 5]]),
    );
  });
});

describe('dates of a month', () => {
  it('lists every date in order', () => {
    const oct = datesOfMonth('2026-10');
    expect(oct).toHaveLength(31);
    expect(oct[0]).toBe('2026-10-01');
    expect(oct[30]).toBe('2026-10-31');
    expect(datesOfMonth('2026-11')).toHaveLength(30);
    expect(datesOfMonth('2026-12')[30]).toBe('2026-12-31');
  });

  it('knows leap years', () => {
    expect(datesOfMonth('2026-02')).toHaveLength(28);
    expect(datesOfMonth('2024-02')).toHaveLength(29);
    expect(datesOfMonth('2024-02')[28]).toBe('2024-02-29');
    expect(datesOfMonth('2000-02')).toHaveLength(29);
    expect(datesOfMonth('2100-02')).toHaveLength(28);
    // February 2024 (leap) Monday to Saturday: 29 days less 4 Sundays.
    expect(monthSummary(cal(), '2024-02').workingDays).toBe(25);
  });
});

describe('labels and keys', () => {
  it('cleans labels: trimmed, spaces collapsed, at most 60 characters, empty is none', () => {
    expect(cleanLabel('  Diwali   holiday ')).toBe('Diwali holiday');
    expect(cleanLabel('   ')).toBeNull();
    expect(cleanLabel(null)).toBeNull();
    expect(cleanLabel(5)).toBeNull();
    expect(cleanLabel('x'.repeat(80))).toHaveLength(LABEL_MAX);
  });

  it('validates months and date keys', () => {
    expect(isValidMonth('2026-10')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-00')).toBe(false);
    expect(isValidMonth('2026-1')).toBe(false);
    expect(isValidMonth('2026-10-01')).toBe(false);
    expect(isValidDateKey('2024-02-29')).toBe(true);
    expect(isValidDateKey('2026-02-29')).toBe(false);
  });
});
