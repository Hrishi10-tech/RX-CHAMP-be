import {
  applyPresetsPatch,
  DEFAULT_REASON_PRESETS,
  isPresetText,
  presetsFromStored,
  reasonAccepted,
  storedAfterPatch,
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

describe('reason presets: what a saved row holds (3.6, C-753, C-754, C-756)', () => {
  /** What 3.2 to 3.5 wrote when a Super Admin saved one list: a copy of all of them. */
  const SAVED_BY_35 = {
    ...DEFAULT_REASON_PRESETS,
    SKIP_COMMENT: ['On a client call', 'In a meeting', 'Deadline', 'Forgot to take it'],
    BREAK_OVERRUN: [
      'A call ran over',
      'Queue at the canteen',
      'Helped a colleague',
      'Lost track of time',
    ],
    DECISION_NOTE: [
      'Approved, thanks for the note',
      'Please take breaks on time',
      'Let us talk about this',
    ],
    LEAVE_REASON: ['Family function'],
  };

  it('a stored copy of a retired default list reads as not saved', () => {
    const read = presetsFromStored(SAVED_BY_35);
    expect(read.SKIP_COMMENT).toEqual(DEFAULT_REASON_PRESETS.SKIP_COMMENT);
    expect(read.BREAK_OVERRUN).toEqual(DEFAULT_REASON_PRESETS.BREAK_OVERRUN);
    expect(read.DECISION_NOTE).toEqual(DEFAULT_REASON_PRESETS.DECISION_NOTE);
    expect(JSON.stringify(read)).not.toMatch(/Forgot to take it|Lost track|Please take breaks/);
  });

  it('a list someone changed stays theirs, old words included', () => {
    const edited = ['On a client call', 'Forgot to take it'];
    const shuffled = ['Forgot to take it', 'On a client call', 'In a meeting', 'Deadline'];
    expect(presetsFromStored({ SKIP_COMMENT: edited }).SKIP_COMMENT).toEqual(edited);
    expect(presetsFromStored({ SKIP_COMMENT: shuffled }).SKIP_COMMENT).toEqual(shuffled);
    expect(presetsFromStored(SAVED_BY_35).LEAVE_REASON).toEqual(['Family function']);
  });

  it('a retired list is only retired for its own kind', () => {
    const list = SAVED_BY_35.SKIP_COMMENT;
    expect(presetsFromStored({ BREAK_LATE: list }).BREAK_LATE).toEqual(list);
  });

  it('a row keeps only the lists someone saved; null takes a list back out', () => {
    const patch = { WFH_REASON: ['Delivery at home'], LEAVE_REASON: null };
    const applied = applyPresetsPatch(presetsFromStored(SAVED_BY_35), patch);
    if (!applied.ok) throw new Error('expected ok');
    const row = storedAfterPatch(SAVED_BY_35, patch, applied.value, applied.changed);
    expect(row.WFH_REASON).toEqual(['Delivery at home']);
    expect(row).not.toHaveProperty('LEAVE_REASON');
    // Nothing else is rewritten, and it still reads the new words.
    expect(row.SKIP_COMMENT).toEqual(SAVED_BY_35.SKIP_COMMENT);
    expect(presetsFromStored(row)).toEqual(applied.value);
  });

  it('nothing stored, one list saved: a row of one', () => {
    const patch = { LEAVE_REASON: ['Family function'] };
    const applied = applyPresetsPatch(presetsFromStored(null), patch);
    if (!applied.ok) throw new Error('expected ok');
    expect(storedAfterPatch(null, patch, applied.value, applied.changed)).toEqual(patch);
  });
});
