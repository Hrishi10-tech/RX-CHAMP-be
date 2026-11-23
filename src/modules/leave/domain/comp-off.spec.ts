import {
  allocateCompOff,
  compOffBalanceOf,
  CompOffCreditRecord,
  CompOffUse,
  earnedUnits,
  expiryOf,
  lotsOf,
  secondsNeeded,
} from './comp-off';

const H = 3600;
const at = new Date('2026-11-01T00:00:00Z');
const credit = (over: Partial<CompOffCreditRecord>): CompOffCreditRecord => ({
  id: over.id ?? 'c1',
  userId: 'u1',
  workedDate: '2026-11-01',
  dayKind: 'WEEKLY_OFF',
  dayLabel: 'Sunday',
  workedSec: 8 * H,
  askedUnits: 4,
  units: 4,
  reason: 'Release',
  source: 'CLAIM',
  status: 'APPROVED',
  approverRole: 'MANAGER',
  approverId: 'm1',
  decidedById: 'm1',
  decidedAt: at,
  decisionNote: null,
  expiresOn: '2026-12-31',
  expiryNoticeAt: null,
  createdById: 'u1',
  cancelledAt: null,
  createdAt: at,
  updatedAt: at,
  ...over,
});
const use = (over: Partial<CompOffUse>): CompOffUse => ({
  requestId: 'r1',
  date: '2026-11-10',
  units: 4,
  status: 'APPROVED',
  order: 1,
  ...over,
});

describe('what an extra day earns', () => {
  it('a full day at 80% of the expected time, a half day at 40%', () => {
    const basis = 8 * H;
    expect(earnedUnits(6.4 * H, basis, 80, 40)).toBe(4);
    expect(earnedUnits(6.39 * H, basis, 80, 40)).toBe(2);
    expect(earnedUnits(3.2 * H, basis, 80, 40)).toBe(2);
    expect(earnedUnits(3.19 * H, basis, 80, 40)).toBe(0);
    expect(earnedUnits(0, basis, 80, 40)).toBe(0);
    expect(secondsNeeded(4, basis, 80, 40)).toBe(6.4 * H);
    expect(secondsNeeded(2, basis, 80, 40)).toBe(3.2 * H);
  });

  it('lapses a set number of days after the day worked', () => {
    expect(expiryOf('2026-11-01', 60)).toBe('2026-12-31');
  });
});

describe('taking comp off against credits', () => {
  it('only approved credits count', () => {
    const lots = lotsOf([credit({ id: 'a' }), credit({ id: 'b', status: 'PENDING', units: 0 })]);
    expect(lots.map((l) => l.id)).toEqual(['a']);
  });

  it('draws on the credit that lapses first, and keeps the later one free', () => {
    const credits = [
      credit({ id: 'late', workedDate: '2026-11-08', expiresOn: '2027-01-07' }),
      credit({ id: 'early', workedDate: '2026-11-01', expiresOn: '2026-12-31' }),
    ];
    const alloc = allocateCompOff(lotsOf(credits), [use({})], '2026-11-05');
    expect(alloc.draws).toEqual([
      { requestId: 'r1', date: '2026-11-10', creditId: 'early', units: 4 },
    ]);
    const b = compOffBalanceOf(alloc, credits);
    expect(b).toMatchObject({
      earnedUnits: 8,
      takenUnits: 4,
      availableUnits: 4,
      nextExpiry: { date: '2027-01-07', units: 4 },
    });
  });

  it('a day after a credit lapses cannot use it', () => {
    const credits = [credit({ expiresOn: '2026-11-30' })];
    const alloc = allocateCompOff(lotsOf(credits), [use({ date: '2026-12-02' })], '2026-11-05');
    expect(alloc.shortUnits).toBe(4);
  });

  it('two half-day credits make one full day', () => {
    const credits = [
      credit({ id: 'h1', units: 2, askedUnits: 2 }),
      credit({
        id: 'h2',
        units: 2,
        askedUnits: 2,
        workedDate: '2026-11-02',
        expiresOn: '2027-01-01',
      }),
    ];
    const alloc = allocateCompOff(lotsOf(credits), [use({})], '2026-11-05');
    expect(alloc.shortUnits).toBe(0);
    expect(alloc.draws.map((d) => d.creditId)).toEqual(['h1', 'h2']);
  });

  it('waiting leave holds its credit; what is not drawn by the expiry lapses', () => {
    const credits = [
      credit({ id: 'a', expiresOn: '2026-11-20' }),
      credit({ id: 'b', expiresOn: '2026-12-20' }),
    ];
    const alloc = allocateCompOff(
      lotsOf(credits),
      [use({ status: 'PENDING', date: '2026-11-18' })],
      '2026-11-25',
    );
    const b = compOffBalanceOf(alloc, credits);
    expect(b).toMatchObject({ pendingUnits: 4, lapsedUnits: 0, availableUnits: 4 });
    const later = allocateCompOff(lotsOf(credits), [], '2026-11-25');
    expect(compOffBalanceOf(later, credits)).toMatchObject({ lapsedUnits: 4, availableUnits: 4 });
  });

  it('finds a fit whenever one exists (greedy by date, earliest expiry first)', () => {
    // A: valid to 15 Nov; B: valid to 30 Nov. Days 14 Nov and 20 Nov: A must go to the 14th.
    const credits = [
      credit({ id: 'B', expiresOn: '2026-11-30' }),
      credit({ id: 'A', expiresOn: '2026-11-15' }),
    ];
    const uses = [
      use({ requestId: 'x', date: '2026-11-20' }),
      use({ requestId: 'y', date: '2026-11-14' }),
    ];
    const alloc = allocateCompOff(lotsOf(credits), uses, '2026-11-01');
    expect(alloc.shortUnits).toBe(0);
    expect(alloc.draws.find((d) => d.requestId === 'y')?.creditId).toBe('A');
  });

  it('claims waiting are counted apart', () => {
    const credits = [credit({ id: 'w', status: 'PENDING', units: 0, askedUnits: 2 })];
    expect(
      compOffBalanceOf(allocateCompOff(lotsOf(credits), [], '2026-11-05'), credits),
    ).toMatchObject({
      availableUnits: 0,
      claimsWaitingUnits: 2,
    });
  });
});
