import {
  cleanPunch,
  dayKeyForPunch,
  dedupePunches,
  normalizeCode,
  normalizeDirection,
  parsePunchTime,
  planBiometricDay,
  PlanOptions,
} from './punch';
import { applyBiometricPatch, BIOTIME_PULL, DEFAULT_BIOMETRIC } from './biometric-settings';

const TZ = 'Asia/Kolkata';
const ist = (hm: string, day = '2026-11-04') => {
  const [h, m] = hm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m) - 330 * 60_000);
};
const H = 3_600_000;

function opts(over: Partial<PlanOptions> = {}): PlanOptions {
  return {
    gapRule: 'SPAN',
    missingCheckout: 'LAST_PUNCH',
    duplicateWindowSec: 60,
    cutoff: ist('22:00'),
    shiftEnd: ist('18:00'),
    now: ist('12:00'),
    ...over,
  };
}

describe('codes and directions', () => {
  it('codes match whatever the device writes: case, spaces, leading zeros', () => {
    expect(normalizeCode(' e1042 ')).toBe('E1042');
    expect(normalizeCode('0042')).toBe('42');
    expect(normalizeCode(42)).toBe('42');
    expect(normalizeCode('000')).toBe('0');
    expect(normalizeCode('E 0042')).toBe('E0042');
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('x'.repeat(65))).toBeNull();
  });

  it('directions: words; numbers only through the integration mapping', () => {
    expect(normalizeDirection('in')).toBe('IN');
    expect(normalizeDirection('CheckOut')).toBe('OUT');
    expect(normalizeDirection('0')).toBeNull();
    expect(normalizeDirection('0', { inWords: ['0'], outWords: ['1'] })).toBe('IN');
    expect(normalizeDirection('1', { inWords: ['0'], outWords: ['1'] })).toBe('OUT');
    expect(normalizeDirection(undefined)).toBeNull();
  });
});

describe('punch times', () => {
  it('reads ISO with an offset, local business time, and epoch seconds or milliseconds', () => {
    const at = ist('09:02');
    expect(parsePunchTime('2026-11-04T09:02:00+05:30', TZ)).toEqual(at);
    expect(parsePunchTime('2026-11-04T03:32:00Z', TZ)).toEqual(at);
    expect(parsePunchTime('2026-11-04 09:02:00', TZ)).toEqual(at);
    expect(parsePunchTime('2026-11-04 09:02', TZ)).toEqual(at);
    expect(parsePunchTime(at.getTime() / 1000, TZ)).toEqual(at);
    expect(parsePunchTime(at.getTime(), TZ)).toEqual(at);
    expect(parsePunchTime(String(at.getTime() / 1000), TZ)).toEqual(at);
    expect(parsePunchTime('yesterday', TZ)).toBeNull();
    expect(parsePunchTime('2026-02-30 09:00', TZ)).toBeNull();
  });

  it('a punch from the future or from long ago is refused, with why', () => {
    const now = ist('12:00');
    expect(cleanPunch({ code: 'E1', time: '2026-11-04 13:00' }, { now, tz: TZ })).toMatchObject({
      ok: false,
    });
    expect(cleanPunch({ code: 'E1', time: '2024-01-01 09:00' }, { now, tz: TZ })).toMatchObject({
      ok: false,
    });
    expect(cleanPunch({ code: '', time: '2026-11-04 09:00' }, { now, tz: TZ })).toMatchObject({
      ok: false,
    });
    const ok = cleanPunch(
      {
        code: '0042',
        time: '2026-11-04T09:02:11.735+05:30',
        direction: 'in',
        deviceId: ' GATE-1 ',
      },
      { now, tz: TZ },
    );
    expect(ok).toMatchObject({
      ok: true,
      value: { codeKey: '42', direction: 'IN', deviceId: 'GATE-1' },
    });
    // Whole seconds, so a device that sends milliseconds and one that does not agree.
    if (ok.ok) expect(ok.value.punchedAt.getUTCMilliseconds()).toBe(0);
  });
});

describe('a biometric day: first punch to last punch', () => {
  it('runs from the first check-in and stays open until a check-out', () => {
    const plan = planBiometricDay([{ at: ist('09:02'), direction: 'IN' }], opts());
    expect(plan).toMatchObject({ open: true, checkoutMissing: false });
    expect(plan.sessions).toEqual([{ startedAt: ist('09:02'), endedAt: null, endReason: null }]);
  });

  it('counts the whole span, lunch inside it, extra hours too', () => {
    const plan = planBiometricDay(
      [
        { at: ist('09:00'), direction: 'IN' },
        { at: ist('13:00'), direction: 'OUT' },
        { at: ist('14:00'), direction: 'IN' },
        { at: ist('20:00'), direction: 'OUT' },
      ],
      opts({ now: ist('21:00') }),
    );
    expect(plan.open).toBe(false);
    expect(plan.sessions).toHaveLength(1);
    const s = plan.sessions[0];
    expect(s.endedAt!.getTime() - s.startedAt.getTime()).toBe(11 * H);
  });

  it('with no directions, an odd number of punches is still open', () => {
    expect(planBiometricDay([{ at: ist('09:00'), direction: null }], opts()).open).toBe(true);
    expect(
      planBiometricDay(
        [
          { at: ist('09:00'), direction: null },
          { at: ist('18:00'), direction: null },
        ],
        opts({ now: ist('19:00') }),
      ).open,
    ).toBe(false);
  });

  it('a finger held on the reader is one punch', () => {
    const list = dedupePunches(
      [
        { at: ist('09:00'), direction: 'IN' },
        { at: new Date(ist('09:00').getTime() + 20_000), direction: 'IN' },
        { at: new Date(ist('09:00').getTime() + 40_000), direction: null },
      ],
      60,
    );
    expect(list).toHaveLength(1);
  });

  it('no check-out by the cutoff: closes at the last punch, or at the shift end', () => {
    const punches = [
      { at: ist('09:00'), direction: 'IN' as const },
      { at: ist('13:00'), direction: 'OUT' as const },
      { at: ist('14:00'), direction: 'IN' as const },
    ];
    const last = planBiometricDay(punches, opts({ now: ist('23:00') }));
    expect(last).toMatchObject({ open: false, checkoutMissing: true });
    expect(last.sessions[0]).toMatchObject({ endedAt: ist('14:00'), endReason: 'AUTO_CLOSED' });
    const shift = planBiometricDay(
      punches,
      opts({ now: ist('23:00'), missingCheckout: 'SHIFT_END' }),
    );
    expect(shift.sessions[0].endedAt).toEqual(ist('18:00'));
  });

  it('PAIRS leaves the time between a check-out and the next check-in out', () => {
    const plan = planBiometricDay(
      [
        { at: ist('09:00'), direction: 'IN' },
        { at: ist('13:00'), direction: 'OUT' },
        { at: ist('14:00'), direction: 'IN' },
        { at: ist('18:00'), direction: 'OUT' },
      ],
      opts({ gapRule: 'PAIRS', now: ist('19:00') }),
    );
    expect(plan.sessions.map((s) => [s.startedAt, s.endedAt])).toEqual([
      [ist('09:00'), ist('13:00')],
      [ist('14:00'), ist('18:00')],
    ]);
  });

  it('a day whose first punch is a check-out says nobody checked in', () => {
    const plan = planBiometricDay(
      [{ at: ist('18:00'), direction: 'OUT' }],
      opts({ now: ist('19:00') }),
    );
    expect(plan).toMatchObject({ open: false, checkinMissing: true });
  });
});

describe('the day a punch belongs to', () => {
  it('its shift-day, unless it closes an open day from the evening before (within 16 hours)', () => {
    const base = { shiftDay: '2026-11-05', shiftDayHasPunches: false };
    expect(
      dayKeyForPunch({
        ...base,
        at: ist('01:00', '2026-11-05'),
        previous: { open: true, firstAt: ist('10:00') },
      }),
    ).toBe('2026-11-04');
    expect(
      dayKeyForPunch({
        ...base,
        at: ist('09:00', '2026-11-05'),
        previous: { open: true, firstAt: ist('09:00') },
      }),
    ).toBe('2026-11-05');
    expect(
      dayKeyForPunch({
        ...base,
        at: ist('01:00', '2026-11-05'),
        previous: { open: false, firstAt: ist('10:00') },
      }),
    ).toBe('2026-11-05');
    expect(
      dayKeyForPunch({
        ...base,
        shiftDayHasPunches: true,
        at: ist('01:00', '2026-11-05'),
        previous: { open: true, firstAt: ist('10:00') },
      }),
    ).toBe('2026-11-05');
  });
});

describe('biometric settings', () => {
  it('choosing the BioTime preset fills its mapping', () => {
    const r = applyBiometricPatch(DEFAULT_BIOMETRIC, {
      pull: { preset: 'BIOTIME', url: 'https://bio.example.com/iclock/api/transactions/' },
    });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.value.pull.fields).toEqual(BIOTIME_PULL.fields);
      expect(r.value.pull.inWords).toEqual(['0', '3', '4']);
      expect(r.value.pull.url).toBe('https://bio.example.com/iclock/api/transactions/');
    }
  });

  it('refuses what it does not know, and a pull with no URL', () => {
    expect(applyBiometricPatch(DEFAULT_BIOMETRIC, { gapRule: 'ALL' })).toMatchObject({
      ok: false,
      field: 'gapRule',
    });
    expect(applyBiometricPatch(DEFAULT_BIOMETRIC, { pull: { enabled: true } })).toMatchObject({
      ok: false,
      field: 'pull.url',
    });
    expect(applyBiometricPatch(DEFAULT_BIOMETRIC, { pull: { url: 'ftp://x' } })).toMatchObject({
      ok: false,
    });
    expect(applyBiometricPatch(DEFAULT_BIOMETRIC, { pull: { nope: 1 } })).toMatchObject({
      ok: false,
    });
  });
});
