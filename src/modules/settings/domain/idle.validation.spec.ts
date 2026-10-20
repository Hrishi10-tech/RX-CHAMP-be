import {
  AwayReason,
  BUILT_IN_REASONS,
  MAX_CUSTOM_REASONS,
  ReasonInput,
  applyReasonsUpdate,
  customReasonKey,
  idleFromStored,
  validateDepartmentIdle,
} from './idle.rules';

const builtIns = (): ReasonInput[] => BUILT_IN_REASONS.map((b) => ({ key: b.key, label: b.label }));
const current = (customs: AwayReason[] = []): AwayReason[] => [
  ...BUILT_IN_REASONS.map((b) => ({ ...b })),
  ...customs,
];

describe('input tracking: reasons update', () => {
  it('keeps the built-ins and lets them be renamed', () => {
    const input = builtIns().map((r) =>
      r.key === 'THINKING' ? { ...r, label: '  Deep   thinking ' } : r,
    );
    const r = applyReasonsUpdate(current(), input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.find((x) => x.key === 'THINKING')).toEqual({
      key: 'THINKING',
      label: 'Deep thinking',
      kind: 'THINKING',
      builtIn: true,
    });
    expect(r.value.slice(0, 5).map((x) => x.key)).toEqual([
      'BREAK',
      'THINKING',
      'MEETING',
      'HARDWARE',
      'OTHER',
    ]);
  });

  it('refuses to remove a built-in', () => {
    const r = applyReasonsUpdate(
      current(),
      builtIns().filter((x) => x.key !== 'HARDWARE'),
    );
    expect(r).toMatchObject({ ok: false, code: 'REASON_BUILT_IN' });
    if (!r.ok) expect(r.message).toMatch(/Working on hardware/);
  });

  it('generates a C_ key for a new custom reason from its label', () => {
    const r = applyReasonsUpdate(current(), [...builtIns(), { label: 'Lab bench work' }]);
    expect(r.ok && r.value[5]).toEqual({
      key: 'C_LAB_BENCH_WORK',
      label: 'Lab bench work',
      kind: 'CUSTOM',
      builtIn: false,
    });
  });

  it('never reuses a key, even one that is being removed', () => {
    const old: AwayReason = { key: 'C_LAB', label: 'Lab', kind: 'CUSTOM', builtIn: false };
    const r = applyReasonsUpdate(current([old]), [...builtIns(), { label: 'Lab' }]);
    expect(r.ok && r.value[5].key).toBe('C_LAB_2');
  });

  it('keeps the key of an existing custom reason when its label changes', () => {
    const old: AwayReason = { key: 'C_LAB', label: 'Lab', kind: 'CUSTOM', builtIn: false };
    const r = applyReasonsUpdate(current([old]), [
      ...builtIns(),
      { key: 'C_LAB', label: 'Laboratory' },
    ]);
    expect(r.ok && r.value[5]).toEqual({
      key: 'C_LAB',
      label: 'Laboratory',
      kind: 'CUSTOM',
      builtIn: false,
    });
  });

  it('keeps a new custom key made by the portal (CUSTOM_ or C_ shape)', () => {
    const r = applyReasonsUpdate(current(), [
      ...builtIns(),
      { key: 'CUSTOM_CLIENT_CALL', label: 'Client call' },
      { key: 'C_BENCH', label: 'Bench work' },
    ]);
    expect(r.ok && r.value.slice(5).map((x) => x.key)).toEqual(['CUSTOM_CLIENT_CALL', 'C_BENCH']);
    expect(
      idleFromStored({ idleReasons: r.ok ? r.value : [] }).reasons.map((x) => x.key),
    ).toContain('CUSTOM_CLIENT_CALL');
  });

  it('refuses any other unknown key', () => {
    for (const key of ['MADE_UP', 'custom_lower', 'CUSTOM_', 'X_THING']) {
      const r = applyReasonsUpdate(current(), [...builtIns(), { key, label: 'Made up' }]);
      expect(r).toMatchObject({ ok: false, code: 'REASON_UNKNOWN' });
    }
  });

  it.each([
    ['too short', 'x'],
    ['too long', 'y'.repeat(41)],
    ['blank', '   '],
  ])('refuses a label that is %s', (_why, label) => {
    const r = applyReasonsUpdate(current(), [...builtIns(), { label }]);
    expect(r).toMatchObject({ ok: false, code: 'REASON_LABEL' });
  });

  it('refuses two reasons with the same label, ignoring case', () => {
    const r = applyReasonsUpdate(current(), [...builtIns(), { label: 'thinking' }]);
    expect(r).toMatchObject({ ok: false, code: 'REASON_DUPLICATE' });
  });

  it('allows at most 20 custom reasons', () => {
    const many = Array.from({ length: MAX_CUSTOM_REASONS }, (_, i) => ({
      label: `Reason ${i + 1}`,
    }));
    expect(applyReasonsUpdate(current(), [...builtIns(), ...many]).ok).toBe(true);
    const r = applyReasonsUpdate(current(), [...builtIns(), ...many, { label: 'One more' }]);
    expect(r).toMatchObject({ ok: false, code: 'TOO_MANY_REASONS' });
  });

  it('round-trips through the stored form', () => {
    const r = applyReasonsUpdate(current(), [...builtIns(), { label: 'Soldering' }]);
    if (!r.ok) throw new Error('expected ok');
    const stored = r.value.map(({ key, label, kind }) => ({ key, label, kind }));
    expect(idleFromStored({ idleReasons: stored }).reasons).toEqual(r.value);
  });
});

describe('input tracking: custom reason keys', () => {
  it('slugs labels into capitals and underscores', () => {
    expect(customReasonKey('Client call / follow-up', new Set())).toBe('C_CLIENT_CALL_FOLLOW_UP');
    expect(customReasonKey('Café visit', new Set())).toBe('C_CAFE_VISIT');
    expect(customReasonKey('!!!', new Set())).toBe('C_REASON');
  });

  it('makes keys unique', () => {
    expect(customReasonKey('Lab', new Set(['C_LAB', 'C_LAB_2']))).toBe('C_LAB_3');
  });

  it('always matches the stored key pattern', () => {
    const key = customReasonKey('x'.repeat(80), new Set());
    expect(key).toMatch(/^C_[A-Za-z0-9_-]{1,40}$/);
  });
});

describe('input tracking: department override', () => {
  const reasons = current([{ key: 'C_LAB', label: 'Lab', kind: 'CUSTOM', builtIn: false }]);

  it('accepts nulls (organisation default)', () => {
    expect(validateDepartmentIdle({}, reasons)).toEqual({
      ok: true,
      value: { enabled: null, minutes: null, reasonKeys: null },
    });
  });

  it('accepts known keys and stores them in the organisation order', () => {
    expect(
      validateDepartmentIdle(
        { enabled: true, minutes: 10, reasonKeys: ['C_LAB', 'HARDWARE', 'BREAK', 'C_LAB'] },
        reasons,
      ),
    ).toEqual({
      ok: true,
      value: { enabled: true, minutes: 10, reasonKeys: ['BREAK', 'HARDWARE', 'C_LAB'] },
    });
  });

  it('refuses unknown keys', () => {
    expect(validateDepartmentIdle({ reasonKeys: ['NOPE'] }, reasons)).toMatchObject({
      ok: false,
      code: 'REASON_UNKNOWN',
    });
  });

  it.each([1, 61, 2.5])('refuses %p minutes', (minutes) => {
    expect(validateDepartmentIdle({ minutes }, reasons)).toMatchObject({
      ok: false,
      field: 'minutes',
    });
  });

  it('accepts the bounds', () => {
    expect(validateDepartmentIdle({ minutes: 2 }, reasons).ok).toBe(true);
    expect(validateDepartmentIdle({ minutes: 60 }, reasons).ok).toBe(true);
  });
});
