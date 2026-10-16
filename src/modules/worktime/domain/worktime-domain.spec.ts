import { agentGeneration, isAgent31 } from './agent-generation';
import { intersect, lengthMs, normalize, overlaps, subtract } from './intervals';
import { autoCloseAt, isStale, latestEndOf } from './auto-close';
import { isOwed, planAutoSkips } from './owed';
import { dueAtFrom, needsEscalation, needsReminder, slaState } from './sla';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

/** An IST wall time on Tue 13 Oct 2026 as an instant. */
const ist = (hm: string, day = 13) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h, m) - 330 * 60_000);
};

describe('agentGeneration', () => {
  it.each([
    ['RXVisionAgent/3.1.0 (Windows)', 'AGENT_31'],
    ['RXVisionAgent/3.1 (macOS)', 'AGENT_31'],
    ['RXVisionAgent/3.12.4 (Windows)', 'AGENT_31'],
    ['RXVisionAgent/4.0.0 (Windows)', 'AGENT_31'],
    ['RXVisionAgent/10.0.0 (Windows)', 'AGENT_31'],
    ['RXVisionAgent/3.0.0 (windows)', 'LEGACY'],
    ['RXVisionAgent/2.9.1 (Windows)', 'LEGACY'],
    ['Mozilla/5.0 (Windows NT 10.0) RXVisionAgent/3.1.0', 'LEGACY'],
    ['rxvisionagent/3.1.0', 'LEGACY'],
    ['RXVisionAgent/x.y', 'LEGACY'],
    ['', 'LEGACY'],
    [undefined, 'LEGACY'],
    [null, 'LEGACY'],
  ])('%p is %s', (ua, gen) => {
    expect(agentGeneration(ua as string | undefined)).toBe(gen);
    expect(isAgent31(ua as string | undefined)).toBe(gen === 'AGENT_31');
  });
});

describe('intervals', () => {
  it('normalizes by merging overlapping and touching pieces and dropping empty ones', () => {
    expect(
      normalize([
        { start: 10, end: 20 },
        { start: 0, end: 5 },
        { start: 5, end: 8 },
        { start: 15, end: 30 },
        { start: 40, end: 40 },
      ]),
    ).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 30 },
    ]);
  });

  it('intersects, subtracts and measures', () => {
    const a = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ];
    const b = [{ start: 5, end: 25 }];
    expect(intersect(a, b)).toEqual([
      { start: 5, end: 10 },
      { start: 20, end: 25 },
    ]);
    expect(subtract(a, b)).toEqual([
      { start: 0, end: 5 },
      { start: 25, end: 30 },
    ]);
    expect(lengthMs(a)).toBe(20);
    expect(subtract([{ start: 0, end: 10 }], [{ start: -5, end: 15 }])).toEqual([]);
  });

  it('treats touching ends as not overlapping', () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(overlaps({ start: 0, end: 10 }, { start: 9, end: 20 })).toBe(true);
  });
});

describe('auto-close', () => {
  const shiftEnd = ist('18:30');

  it('closes 240 min after the shift end, or 14h after the start with no shift', () => {
    expect(
      latestEndOf({ startedAt: ist('09:30'), shiftEnd, autoCloseAfterShiftEndMin: 240 }),
    ).toEqual(ist('22:30'));
    expect(
      latestEndOf({ startedAt: ist('09:30'), shiftEnd: null, autoCloseAfterShiftEndMin: 240 }),
    ).toEqual(ist('23:30'));
  });

  it('never closes a session sooner than the grace after it started (a late resume)', () => {
    expect(
      latestEndOf({ startedAt: ist('23:05'), shiftEnd, autoCloseAfterShiftEndMin: 240 }),
    ).toEqual(ist('03:05', 14));
  });

  it('is stale only strictly after latestEnd', () => {
    expect(isStale(ist('22:30'), ist('22:30'))).toBe(false);
    expect(isStale(ist('22:30'), new Date(ist('22:30').getTime() + 1))).toBe(true);
  });

  it('closes at the last input, clamped to the session and latestEnd', () => {
    const base = { startedAt: ist('09:30'), latestEnd: ist('22:30') };
    expect(autoCloseAt({ ...base, lastInput: ist('18:45') })).toEqual(ist('18:45'));
    expect(autoCloseAt({ ...base, lastInput: ist('23:10') })).toEqual(ist('22:30'));
    expect(autoCloseAt({ ...base, lastInput: ist('09:00') })).toEqual(ist('09:30'));
    expect(autoCloseAt({ ...base, lastInput: null })).toEqual(ist('09:30'));
  });
});

describe('owed and auto-skip planning', () => {
  const morning = {
    kind: 'MORNING',
    scheduledStart: ist('11:00'),
    windowOpen: ist('10:30'),
    windowClose: ist('12:00'),
  };
  const lunch = {
    kind: 'LUNCH',
    scheduledStart: ist('13:00'),
    windowOpen: ist('12:30'),
    windowClose: ist('14:00'),
  };

  it('a break is owed when a session covers its scheduled start, an open one up to now', () => {
    expect(isOwed(morning, [{ startedAt: ist('09:30'), endedAt: null }], ist('10:00'))).toBe(false);
    expect(isOwed(morning, [{ startedAt: ist('09:30'), endedAt: null }], ist('11:00'))).toBe(true);
    expect(isOwed(morning, [{ startedAt: ist('11:30'), endedAt: null }], ist('12:30'))).toBe(false);
    expect(
      isOwed(morning, [{ startedAt: ist('09:30'), endedAt: ist('10:45') }], ist('13:00')),
    ).toBe(false);
    expect(
      isOwed(morning, [{ startedAt: ist('09:30'), endedAt: ist('11:00') }], ist('13:00')),
    ).toBe(true);
  });

  it('auto-skips at the window close only owed breaks with no record', () => {
    const sessions = [{ startedAt: ist('09:30'), endedAt: null }];
    expect(planAutoSkips([morning, lunch], new Set(), sessions, ist('12:00'), false)).toEqual([
      { kind: 'MORNING', startedAt: ist('12:00'), atEndDay: false },
    ]);
    expect(
      planAutoSkips([morning, lunch], new Set(['MORNING']), sessions, ist('15:00'), false),
    ).toEqual([{ kind: 'LUNCH', startedAt: ist('14:00'), atEndDay: false }]);
    // Late arrival: the morning break was never owed.
    expect(
      planAutoSkips(
        [morning],
        new Set(),
        [{ startedAt: ist('11:30'), endedAt: null }],
        ist('13:00'),
        false,
      ),
    ).toEqual([]);
  });

  it('at End Day an owed break inside its open window becomes a skip at now', () => {
    const sessions = [{ startedAt: ist('09:30'), endedAt: null }];
    expect(planAutoSkips([morning], new Set(), sessions, ist('11:20'), true)).toEqual([
      { kind: 'MORNING', startedAt: ist('11:20'), atEndDay: true },
    ]);
    // Not before the scheduled start: not owed yet.
    expect(planAutoSkips([morning], new Set(), sessions, ist('10:45'), true)).toEqual([]);
    // Outside End Day, an open window is left alone.
    expect(planAutoSkips([morning], new Set(), sessions, ist('11:20'), false)).toEqual([]);
  });
});

describe('the 48-hour rule', () => {
  const now = ist('10:00');

  it('due date is now plus the SLA', () => {
    expect(dueAtFrom(now, 48).getTime() - now.getTime()).toBe(48 * 3_600_000);
  });

  it('is due soon within 12h, overdue past due, never both', () => {
    expect(slaState('PENDING', new Date(now.getTime() + 13 * 3_600_000), now)).toEqual({
      dueInSec: 13 * 3600,
      dueSoon: false,
      overdue: false,
    });
    expect(slaState('PENDING', new Date(now.getTime() + 12 * 3_600_000), now)).toMatchObject({
      dueSoon: true,
      overdue: false,
    });
    expect(slaState('PENDING', new Date(now.getTime() - 6 * 3_600_000), now)).toEqual({
      dueInSec: -6 * 3600,
      dueSoon: false,
      overdue: true,
    });
    expect(slaState('APPROVED', new Date(now.getTime() - 1), now)).toEqual({
      dueInSec: null,
      dueSoon: false,
      overdue: false,
    });
    expect(slaState('PENDING', null, now).dueInSec).toBeNull();
  });

  it('reminds once inside 12h and escalates once past due', () => {
    const soon = new Date(now.getTime() + 2 * 3_600_000);
    const past = new Date(now.getTime() - 60_000);
    expect(needsReminder({ dueAt: soon, remindedAt: null }, now)).toBe(true);
    expect(needsReminder({ dueAt: soon, remindedAt: now }, now)).toBe(false);
    expect(needsReminder({ dueAt: past, remindedAt: null }, now)).toBe(false);
    expect(
      needsReminder({ dueAt: new Date(now.getTime() + 13 * 3_600_000), remindedAt: null }, now),
    ).toBe(false);
    expect(needsEscalation({ dueAt: past, escalatedAt: null }, now)).toBe(true);
    expect(needsEscalation({ dueAt: past, escalatedAt: now }, now)).toBe(false);
    expect(needsEscalation({ dueAt: soon, escalatedAt: null }, now)).toBe(false);
  });
});
