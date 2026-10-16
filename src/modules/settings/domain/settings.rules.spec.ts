import {
  DEFAULT_SETTINGS,
  SETTING_BOUNDS,
  applySettingsPatch,
  settingsFromStored,
} from './settings.rules';

describe('settings rules', () => {
  it('has the SPEC 1.10 defaults', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      approvalSlaHours: 48,
      blockManagerEndDayWhenOverdue: true,
      fullDayPct: 80,
      halfDayPct: 40,
      lateStartGraceMin: 10,
      quietHourActiveMin: 20,
      quietHoursFlag: 4,
      autoCloseAfterShiftEndMin: 240,
    });
  });

  it('applies a valid subset and reports what changed', () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { approvalSlaHours: 24, quietHoursFlag: 4 });
    expect(r).toEqual({
      ok: true,
      value: { ...DEFAULT_SETTINGS, approvalSlaHours: 24 },
      changed: ['approvalSlaHours'],
    });
  });

  it.each([
    ['approvalSlaHours', 11],
    ['approvalSlaHours', 169],
    ['approvalSlaHours', 24.5],
    ['approvalSlaHours', '48'],
    ['fullDayPct', 101],
    ['halfDayPct', 0],
    ['halfDayPct', 100],
    ['lateStartGraceMin', -1],
    ['lateStartGraceMin', 121],
    ['quietHourActiveMin', 60],
    ['quietHoursFlag', 0],
    ['autoCloseAfterShiftEndMin', 29],
    ['autoCloseAfterShiftEndMin', 721],
    ['blockManagerEndDayWhenOverdue', 'yes'],
    ['blockManagerEndDayWhenOverdue', 1],
  ])('refuses %s = %p with the field named', (field, value) => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, { [field]: value });
    expect(r).toMatchObject({ ok: false, field });
  });

  it('accepts every bound exactly', () => {
    for (const [key, { min, max }] of Object.entries(SETTING_BOUNDS)) {
      const base =
        key === 'halfDayPct'
          ? { ...DEFAULT_SETTINGS, fullDayPct: 100 }
          : key === 'fullDayPct'
            ? { ...DEFAULT_SETTINGS, halfDayPct: 1 }
            : DEFAULT_SETTINGS;
      const lowOk = key === 'fullDayPct' ? 2 : min;
      expect(applySettingsPatch(base, { [key]: lowOk }).ok).toBe(true);
      expect(applySettingsPatch(base, { [key]: max }).ok).toBe(true);
    }
  });

  it('keeps a full day above a half day, naming the field that was sent', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { fullDayPct: 40 })).toMatchObject({
      ok: false,
      field: 'fullDayPct',
    });
    expect(applySettingsPatch(DEFAULT_SETTINGS, { halfDayPct: 85 })).toMatchObject({
      ok: false,
      field: 'halfDayPct',
    });
    expect(applySettingsPatch(DEFAULT_SETTINGS, { fullDayPct: 50, halfDayPct: 60 })).toMatchObject({
      ok: false,
      field: 'fullDayPct',
    });
    expect(applySettingsPatch(DEFAULT_SETTINGS, { fullDayPct: 60, halfDayPct: 30 }).ok).toBe(true);
  });

  it('ignores unknown keys and undefined values', () => {
    const r = applySettingsPatch(DEFAULT_SETTINGS, {
      fullDayPct: undefined,
      nonsense: 5,
    } as Record<string, unknown>);
    expect(r).toEqual({ ok: true, value: DEFAULT_SETTINGS, changed: [] });
  });

  it('reads stored values over the defaults and drops anything invalid', () => {
    expect(settingsFromStored(null)).toEqual(DEFAULT_SETTINGS);
    expect(settingsFromStored([1, 2])).toEqual(DEFAULT_SETTINGS);
    expect(
      settingsFromStored({ approvalSlaHours: 24, quietHoursFlag: 999, lateStartGraceMin: 'x' }),
    ).toEqual({ ...DEFAULT_SETTINGS, approvalSlaHours: 24 });
    // A stored pair that contradicts itself falls back to the default pair.
    expect(settingsFromStored({ fullDayPct: 30, halfDayPct: 50 })).toMatchObject({
      fullDayPct: 80,
      halfDayPct: 40,
    });
  });
});
