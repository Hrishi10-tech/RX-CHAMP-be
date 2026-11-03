import { adjustedSecOf, checkAdjustment, mayAdjustFocus, signedMinutes } from './focus-adjustment';
import { Role } from '@shared/rbac/roles.enum';

describe('focus adjustments (3.3)', () => {
  it('only the Super Manager adjusts', () => {
    expect(mayAdjustFocus({ role: Role.SUPER_MANAGER })).toBe(true);
    expect(mayAdjustFocus({ role: Role.SUPER_ADMIN })).toBe(false);
    expect(mayAdjustFocus({ role: Role.MANAGER })).toBe(false);
    expect(mayAdjustFocus({ role: Role.USER })).toBe(false);
  });

  it('sums the live adjustments only', () => {
    expect(
      adjustedSecOf([
        { deltaSec: 1800, voidedAt: null },
        { deltaSec: -600, voidedAt: null },
        { deltaSec: 3600, voidedAt: new Date() },
      ]),
    ).toBe(1200);
    expect(adjustedSecOf([])).toBe(0);
  });

  it('checks minutes, reason and date', () => {
    const base = { date: '2026-11-02', today: '2026-11-03', earliest: '2026-09-02' };
    expect(checkAdjustment({ ...base, minutes: 30, reason: ' Agent  crashed at 10:00 ' })).toEqual({
      ok: true,
      deltaSec: 1800,
      reason: 'Agent crashed at 10:00',
    });
    expect(checkAdjustment({ ...base, minutes: -45, reason: 'Counted twice' })).toMatchObject({
      deltaSec: -2700,
    });
    expect(checkAdjustment({ ...base, minutes: 0, reason: 'Nothing' })).toMatchObject({
      ok: false,
      field: 'minutes',
    });
    expect(checkAdjustment({ ...base, minutes: 7.5, reason: 'Nothing' })).toMatchObject({
      ok: false,
      field: 'minutes',
    });
    expect(checkAdjustment({ ...base, minutes: 721, reason: 'Too much' })).toMatchObject({
      ok: false,
      field: 'minutes',
    });
    expect(checkAdjustment({ ...base, minutes: 10, reason: 'Bug' })).toMatchObject({
      ok: false,
      field: 'reason',
    });
    expect(checkAdjustment({ ...base, minutes: 10, reason: 'x'.repeat(301) })).toMatchObject({
      ok: false,
      field: 'reason',
    });
    expect(
      checkAdjustment({ ...base, minutes: 10, reason: 'Tomorrow', date: '2026-11-04' }),
    ).toMatchObject({ ok: false, field: 'date' });
    expect(
      checkAdjustment({ ...base, minutes: 10, reason: 'Too old', date: '2026-09-01' }),
    ).toMatchObject({ ok: false, field: 'date' });
  });

  it('shows signed minutes with a real minus sign', () => {
    expect(signedMinutes(1800)).toBe('+30 min');
    expect(signedMinutes(-900)).toBe('−15 min');
  });
});
