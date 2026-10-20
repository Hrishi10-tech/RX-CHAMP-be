import { CalendarService } from './calendar.service';
import { isWorkingDay, PATTERN_SINCE_ALWAYS } from '../domain/calendar.rules';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

/**
 * 4.0 (audit M2): the week pattern is effective from a date, so a change never
 * rewrites the days before it, and never a month locked for payroll.
 */
const NOW = new Date('2026-10-19T06:00:00Z'); // Monday 19 October, 11:30 in India

function setup(opts: { stored?: Record<string, unknown>; locks?: string[] } = {}) {
  let stored: Record<string, unknown> = { ...(opts.stored ?? { weekPattern: [1, 2, 3, 4, 5, 6] }) };
  const locks = opts.locks ?? [];
  const settings = {
    readRaw: jest.fn(async () => stored),
    writeRaw: jest.fn(async (_c: string, patch: Record<string, unknown>) => {
      stored = { ...stored, ...patch };
      return stored;
    }),
  };
  const prisma = {
    calendarDay: { findMany: jest.fn().mockResolvedValue([]) },
    monthLock: {
      findFirst: jest.fn(async ({ where }: { where: { month: { gte: string } } }) => {
        const hit = locks
          .filter((m) => m >= where.month.gte)
          .sort()
          .reverse()[0];
        return hit ? { month: hit } : null;
      }),
    },
  };
  const events = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
  const svc = new CalendarService(prisma as never, settings as never, events as never);
  return { svc, settings, prisma, events, stored: () => stored };
}

describe('CalendarService week pattern history', () => {
  beforeAll(() =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(NOW),
  );
  afterAll(() => jest.useRealTimers());

  it('a new pattern applies from today: earlier days keep the old one', async () => {
    const t = setup();
    const entry = await t.svc.setWeekPattern('c1', [1, 2, 3, 4, 5], 'admin');
    expect(entry).toEqual({ from: '2026-10-19', days: [1, 2, 3, 4, 5] });
    expect(t.stored().weekPatternHistory).toEqual([
      { from: PATTERN_SINCE_ALWAYS, days: [1, 2, 3, 4, 5, 6] },
      { from: '2026-10-19', days: [1, 2, 3, 4, 5] },
    ]);
    // The single 3.x pattern is left as it was (it is the entry since always).
    expect(t.stored().weekPattern).toEqual([1, 2, 3, 4, 5, 6]);
    const cal = await t.svc.forOrg('c1');
    expect(isWorkingDay(cal, '2026-10-17')).toBe(true); // last Saturday: still worked
    expect(isWorkingDay(cal, '2026-10-24')).toBe(false); // next Saturday: off
    expect(cal.weekPattern).toEqual([1, 2, 3, 4, 5]);
    expect(t.events.publish).toHaveBeenCalled();
  });

  it('GET /calendar carries the current pattern and the history', async () => {
    const t = setup({
      stored: {
        weekPattern: [1, 2, 3, 4, 5, 6],
        weekPatternHistory: [
          { from: PATTERN_SINCE_ALWAYS, days: [1, 2, 3, 4, 5, 6] },
          { from: '2026-11-01', days: [1, 2, 3, 4, 5] },
        ],
      },
    });
    const view = await t.svc.view('c1', 2026);
    expect(view.weekPattern).toEqual([1, 2, 3, 4, 5, 6]); // the November one is not in force yet
    expect(view.weekPatternHistory).toEqual([
      { from: PATTERN_SINCE_ALWAYS, days: [1, 2, 3, 4, 5, 6] },
      { from: '2026-11-01', days: [1, 2, 3, 4, 5] },
    ]);
    expect(view.months.find((m) => m.month === '2026-10')?.workingDays).toBe(27);
    expect(view.months.find((m) => m.month === '2026-11')?.workingDays).toBe(21);
  });

  it('an Admin may pick a date: a future one, or a past one in an open month', async () => {
    const t = setup({ locks: ['2026-08'] });
    expect(await t.svc.setWeekPattern('c1', [1, 2, 3, 4, 5], 'admin', '2026-11-01')).toEqual({
      from: '2026-11-01',
      days: [1, 2, 3, 4, 5],
    });
    expect(await t.svc.setWeekPattern('c1', [1, 2, 3, 4], 'admin', '2026-09-14')).toEqual({
      from: '2026-09-14',
      days: [1, 2, 3, 4],
    });
    // The later November entry gave way to the decision from 14 September on.
    expect(t.stored().weekPatternHistory).toEqual([
      { from: PATTERN_SINCE_ALWAYS, days: [1, 2, 3, 4, 5, 6] },
      { from: '2026-09-14', days: [1, 2, 3, 4] },
    ]);
  });

  it('never a date in or before a month locked for payroll (409 MONTH_LOCKED); nothing is written', async () => {
    const t = setup({ locks: ['2026-09'] });
    await expect(
      t.svc.setWeekPattern('c1', [1, 2, 3, 4, 5], 'admin', '2026-09-30'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'MONTH_LOCKED',
      details: { month: '2026-09' },
    });
    await expect(
      t.svc.setWeekPattern('c1', [1, 2, 3, 4, 5], 'admin', '2026-08-01'),
    ).rejects.toMatchObject({
      status: 409,
      code: 'MONTH_LOCKED',
    });
    expect(t.settings.writeRaw).not.toHaveBeenCalled();
    // From October on is fine: September keeps its pattern.
    await t.svc.setWeekPattern('c1', [1, 2, 3, 4, 5], 'admin', '2026-10-01');
    expect(t.settings.writeRaw).toHaveBeenCalledTimes(1);
  });

  it('refuses a bad date or pattern (400)', async () => {
    const t = setup();
    await expect(t.svc.setWeekPattern('c1', [1, 2], 'admin', '2026-02-30')).rejects.toMatchObject({
      status: 400,
      details: { field: 'from' },
    });
    await expect(t.svc.setWeekPattern('c1', [0], 'admin')).rejects.toMatchObject({
      status: 400,
      details: { field: 'days' },
    });
  });
});
