import {
  applyPresetsPatch,
  DEFAULT_REASON_PRESETS,
  isPresetText,
  presetsFromStored,
  reasonAccepted,
} from './reason-presets';

describe('reason presets (3.2, fix 12)', () => {
  it('fills every kind with its defaults when nothing is stored', () => {
    expect(presetsFromStored(null)).toEqual(DEFAULT_REASON_PRESETS);
    expect(presetsFromStored({ BREAK_SKIP: 'not a list' }).BREAK_SKIP).toEqual(
      DEFAULT_REASON_PRESETS.BREAK_SKIP,
    );
  });

  it('replaces one kind, drops blanks and duplicates, and resets with null', () => {
    const r = applyPresetsPatch(presetsFromStored(null), {
      BREAK_SKIP: [' Client call ', 'client call', '', 'Deadline'],
    });
    expect(r).toMatchObject({ ok: true, changed: ['BREAK_SKIP'] });
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.BREAK_SKIP).toEqual(['Client call', 'Deadline']);
    expect(r.value.LATE_DAY_START).toEqual(DEFAULT_REASON_PRESETS.LATE_DAY_START);
    const back = applyPresetsPatch(r.value, { BREAK_SKIP: null });
    expect(back.ok && back.value.BREAK_SKIP).toEqual(DEFAULT_REASON_PRESETS.BREAK_SKIP);
  });

  it('refuses unknown kinds, non-text items, too many and too long', () => {
    expect(applyPresetsPatch(presetsFromStored(null), { NOPE: [] })).toMatchObject({
      ok: false,
      field: 'NOPE',
    });
    expect(applyPresetsPatch(presetsFromStored(null), { BREAK_SKIP: [1] })).toMatchObject({
      ok: false,
    });
    expect(
      applyPresetsPatch(presetsFromStored(null), {
        BREAK_SKIP: Array.from({ length: 13 }, (_, i) => `Reason ${i}`),
      }),
    ).toMatchObject({ ok: false });
    expect(
      applyPresetsPatch(presetsFromStored(null), { BREAK_SKIP: ['x'.repeat(81)] }),
    ).toMatchObject({ ok: false });
  });

  it('a preset picked as it is counts as a reason whatever its length', () => {
    const list = ['Traffic', 'Doctor appointment'];
    expect(isPresetText(list, 'Traffic')).toBe(true);
    expect(isPresetText(list, '  traffic  ')).toBe(true);
    expect(isPresetText(list, 'Traffic jam')).toBe(false);
    expect(isPresetText([], 'Traffic')).toBe(false);
    expect(reasonAccepted('Traffic', 10, list)).toBe(true);
    expect(reasonAccepted('Late', 10, list)).toBe(false);
    expect(reasonAccepted('Stuck at the toll gate', 10, list)).toBe(true);
    expect(reasonAccepted('', 0, list)).toBe(true);
    expect(reasonAccepted(null, 1, list)).toBe(false);
  });
});
