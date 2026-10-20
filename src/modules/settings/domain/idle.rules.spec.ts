import {
  BUILT_IN_REASONS,
  DEFAULT_REASON_KEYS,
  effectiveIdle,
  IDLE_DEFAULT_MINUTES,
  idleFromStored,
  MAX_CUSTOM_REASONS,
  OrgIdleSettings,
  REASON_FIELDS,
  reasonsFromStored,
} from './idle.rules';

const keysOf = (rs: { key: string }[]) => rs.map((r) => r.key);

describe('away reasons from what is stored (SPEC 2.5)', () => {
  it('nothing stored: the five built-ins with their default labels', () => {
    for (const stored of [undefined, null, 'x', {}, 42]) {
      expect(reasonsFromStored(stored)).toEqual([
        { key: 'BREAK', label: 'Took a break', kind: 'BREAK', builtIn: true },
        { key: 'THINKING', label: 'Thinking', kind: 'THINKING', builtIn: true },
        { key: 'MEETING', label: 'Short meeting', kind: 'MEETING', builtIn: true },
        { key: 'HARDWARE', label: 'Working on hardware', kind: 'HARDWARE', builtIn: true },
        { key: 'OTHER', label: 'Other work', kind: 'OTHER', builtIn: true },
      ]);
    }
  });

  it('renames built-ins (trimmed, spaces collapsed) but keeps their kind and order', () => {
    const r = reasonsFromStored([
      { key: 'OTHER', label: '  Desk   work ' },
      { key: 'THINKING', label: 'Deep thought', kind: 'CUSTOM', builtIn: false },
    ]);
    expect(keysOf(r)).toEqual(['BREAK', 'THINKING', 'MEETING', 'HARDWARE', 'OTHER']);
    expect(r[1]).toEqual({ key: 'THINKING', label: 'Deep thought', kind: 'THINKING', builtIn: true });
    expect(r[4]).toEqual({ key: 'OTHER', label: 'Desk work', kind: 'OTHER', builtIn: true });
  });

  it('a bad rename keeps the default label', () => {
    const r = reasonsFromStored([
      { key: 'THINKING', label: 'x' },
      { key: 'MEETING', label: 'y'.repeat(41) },
      { key: 'HARDWARE', label: 7 },
    ]);
    expect(r.find((x) => x.key === 'THINKING')?.label).toBe('Thinking');
    expect(r.find((x) => x.key === 'MEETING')?.label).toBe('Short meeting');
    expect(r.find((x) => x.key === 'HARDWARE')?.label).toBe('Working on hardware');
  });

  it('adds custom reasons with C_ keys after the built-ins, as CUSTOM', () => {
    const r = reasonsFromStored([
      { key: 'C_lab', label: 'Lab bench' },
      { key: 'C_site-visit_2', label: 'Site visit' },
    ]);
    expect(r.slice(5)).toEqual([
      { key: 'C_lab', label: 'Lab bench', kind: 'CUSTOM', builtIn: false },
      { key: 'C_site-visit_2', label: 'Site visit', kind: 'CUSTOM', builtIn: false },
    ]);
  });

  it('drops customs with a bad key, a bad label or a duplicate key', () => {
    const r = reasonsFromStored([
      { key: 'lab', label: 'No prefix' },
      { key: 'C_', label: 'Empty key' },
      { key: 'C_has space', label: 'Space in key' },
      { key: `C_${'a'.repeat(41)}`, label: 'Key too long' },
      { key: 'C_ok', label: 'A' },
      { key: 'C_ok', label: 'Okay label' },
      { key: 'C_ok', label: 'Duplicate' },
      { key: 7, label: 'Number key' },
      'C_string',
      null,
    ]);
    expect(r.slice(5)).toEqual([{ key: 'C_ok', label: 'Okay label', kind: 'CUSTOM', builtIn: false }]);
  });

  it(`keeps at most ${MAX_CUSTOM_REASONS} custom reasons`, () => {
    const many = Array.from({ length: MAX_CUSTOM_REASONS + 5 }, (_, i) => ({ key: `C_r${i}`, label: `Reason ${i}` }));
    const r = reasonsFromStored(many);
    expect(r).toHaveLength(BUILT_IN_REASONS.length + MAX_CUSTOM_REASONS);
    expect(r[r.length - 1].key).toBe(`C_r${MAX_CUSTOM_REASONS - 1}`);
  });
});

describe('organisation input-tracking settings from the settings row', () => {
  it('defaults: off, 5 minutes, built-in reasons, no department rows', () => {
    expect(idleFromStored({})).toEqual({
      defaultEnabled: false,
      defaultMinutes: IDLE_DEFAULT_MINUTES,
      reasons: reasonsFromStored(undefined),
      departments: {},
    });
    expect(IDLE_DEFAULT_MINUTES).toBe(5);
  });

  it('reads valid stored values', () => {
    const s = idleFromStored({ idleDefaultEnabled: true, idleDefaultMinutes: 15 });
    expect(s.defaultEnabled).toBe(true);
    expect(s.defaultMinutes).toBe(15);
    expect(idleFromStored({ idleDefaultMinutes: 2 }).defaultMinutes).toBe(2);
    expect(idleFromStored({ idleDefaultMinutes: 60 }).defaultMinutes).toBe(60);
  });

  it.each([[1], [61], [7.5], ['10'], [null]])('an invalid default minutes %p falls back to 5', (v) => {
    expect(idleFromStored({ idleDefaultMinutes: v }).defaultMinutes).toBe(5);
  });

  it('a non-boolean enabled falls back to off', () => {
    expect(idleFromStored({ idleDefaultEnabled: 'yes' }).defaultEnabled).toBe(false);
    expect(idleFromStored({ idleDefaultEnabled: 1 }).defaultEnabled).toBe(false);
  });

  it('reads department rows: nulls for anything invalid, unknown reason keys dropped', () => {
    const s = idleFromStored({
      idleReasons: [{ key: 'C_lab', label: 'Lab bench' }],
      departmentIdle: {
        d1: { enabled: true, minutes: 10, reasonKeys: ['BREAK', 'HARDWARE', 'C_lab', 'C_gone', 5] },
        d2: { enabled: 'no', minutes: 1, reasonKeys: 'BREAK' },
        d3: {},
        d4: 'junk',
      },
    });
    expect(s.departments).toEqual({
      d1: { enabled: true, minutes: 10, reasonKeys: ['BREAK', 'HARDWARE', 'C_lab'] },
      d2: { enabled: null, minutes: null, reasonKeys: null },
      d3: { enabled: null, minutes: null, reasonKeys: null },
    });
  });

  it('ignores a departmentIdle that is not an object', () => {
    expect(idleFromStored({ departmentIdle: ['d1'] }).departments).toEqual({});
  });
});

describe('effective input tracking for a person', () => {
  const org: OrgIdleSettings = idleFromStored({
    idleDefaultEnabled: false,
    idleDefaultMinutes: 5,
    idleReasons: [
      { key: 'THINKING', label: 'Pondering' },
      { key: 'C_lab', label: 'Lab bench' },
    ],
    departmentIdle: {
      eng: { enabled: true, minutes: 8, reasonKeys: ['HARDWARE', 'C_lab'] },
      sales: { enabled: null, minutes: null, reasonKeys: null },
      ops: { enabled: false, minutes: 20, reasonKeys: [] },
    },
  });
  const none = { idleEnabled: null, idleMinutes: null };

  it('no department and no override: the organisation default and the default reason set', () => {
    const e = effectiveIdle(org, null, none);
    expect(e.enabled).toBe(false);
    expect(e.minutes).toBe(5);
    expect(keysOf(e.reasons)).toEqual([...DEFAULT_REASON_KEYS]);
  });

  it('the department wins over the organisation', () => {
    const e = effectiveIdle(org, 'eng', none);
    expect(e.enabled).toBe(true);
    expect(e.minutes).toBe(8);
  });

  it('the person wins over the department', () => {
    expect(effectiveIdle(org, 'eng', { idleEnabled: false, idleMinutes: 30 })).toMatchObject({ enabled: false, minutes: 30 });
    expect(effectiveIdle(org, 'ops', { idleEnabled: true, idleMinutes: null })).toMatchObject({ enabled: true, minutes: 20 });
    expect(effectiveIdle(org, null, { idleEnabled: true, idleMinutes: 3 })).toMatchObject({ enabled: true, minutes: 3 });
  });

  it('a department with nulls (or an unknown department) uses the organisation default', () => {
    expect(effectiveIdle(org, 'sales', none)).toMatchObject({ enabled: false, minutes: 5 });
    expect(effectiveIdle(org, 'unknown', none)).toMatchObject({ enabled: false, minutes: 5 });
    expect(keysOf(effectiveIdle(org, 'sales', none).reasons)).toEqual([...DEFAULT_REASON_KEYS]);
  });

  it("offers the department's chosen reasons in the organisation's order, BREAK always", () => {
    expect(keysOf(effectiveIdle(org, 'eng', none).reasons)).toEqual(['BREAK', 'HARDWARE', 'C_lab']);
    // Even an empty choice offers a break.
    expect(keysOf(effectiveIdle(org, 'ops', none).reasons)).toEqual(['BREAK']);
  });

  it('HARDWARE is offered only where a department chose it', () => {
    expect(keysOf(effectiveIdle(org, null, none).reasons)).not.toContain('HARDWARE');
    expect(keysOf(effectiveIdle(org, 'sales', none).reasons)).not.toContain('HARDWARE');
    expect(keysOf(effectiveIdle(org, 'eng', none).reasons)).toContain('HARDWARE');
  });

  it('each reason carries its label (renames applied) and the fields its kind needs', () => {
    const e = effectiveIdle(org, null, none);
    expect(e.reasons).toEqual([
      { key: 'BREAK', label: 'Took a break', kind: 'BREAK', fields: [] },
      { key: 'THINKING', label: 'Pondering', kind: 'THINKING', fields: ['comment'] },
      { key: 'MEETING', label: 'Short meeting', kind: 'MEETING', fields: ['participants', 'comment', 'momSender'] },
      { key: 'OTHER', label: 'Other work', kind: 'OTHER', fields: ['comment'] },
    ]);
    expect(effectiveIdle(org, 'eng', none).reasons.find((r) => r.key === 'C_lab')).toEqual({
      key: 'C_lab',
      label: 'Lab bench',
      kind: 'CUSTOM',
      fields: ['comment'],
    });
  });
});

describe('REASON_FIELDS (SPEC 2.5 table)', () => {
  it('a break needs nothing; a meeting needs people, a summary and the minutes sender; the rest a comment', () => {
    expect(REASON_FIELDS).toEqual({
      BREAK: [],
      THINKING: ['comment'],
      MEETING: ['participants', 'comment', 'momSender'],
      HARDWARE: ['comment'],
      OTHER: ['comment'],
      CUSTOM: ['comment'],
    });
  });

  it('the default set is BREAK, THINKING, MEETING, OTHER', () => {
    expect([...DEFAULT_REASON_KEYS]).toEqual(['BREAK', 'THINKING', 'MEETING', 'OTHER']);
  });
});
