import { PrismaAnalyticsReader } from './prisma-analytics.reader';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

const ist = (date: string, hm: string) => new Date(`${date}T${hm}:00+05:30`);

type Where = { type?: string; date?: unknown; startedAt?: { lt: Date } };

function fakePrisma(live: { startedAt: Date; endedAt: Date | null }[], logged: typeof live) {
  const before = (to?: Date) => (r: { startedAt: Date }) => !to || r.startedAt < to;
  return {
    activitySample: { findMany: jest.fn().mockResolvedValue([]) },
    onlineSession: { findMany: jest.fn().mockResolvedValue([]) },
    presenceSession: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        where.type === 'MEETING' && where.date === undefined
          ? live.filter(before(where.startedAt?.lt))
          : [],
      ),
    },
    meetingRecord: {
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        where.date === undefined ? logged.filter(before(where.startedAt?.lt)) : [],
      ),
    },
  };
}

describe('the analytics window reads meetings by time (D-22)', () => {
  it('a meeting past midnight and one logged on a night shift are on the day their time falls on', async () => {
    const pastMidnight = {
      startedAt: ist('2026-11-05', '23:40'),
      endedAt: ist('2026-11-06', '00:30'),
    };
    const logged = {
      startedAt: ist('2026-11-06', '01:00'),
      endedAt: ist('2026-11-06', '01:30'),
    };
    const win = await new PrismaAnalyticsReader(
      fakePrisma([pastMidnight], [logged]) as never,
    ).loadWindow('u1', ['2026-11-05', '2026-11-06', '2026-11-07']);
    expect(win.meetingsByDate.get('2026-11-05')).toEqual([
      { start: pastMidnight.startedAt, end: pastMidnight.endedAt },
    ]);
    expect(win.meetingsByDate.get('2026-11-06')).toEqual([
      { start: pastMidnight.startedAt, end: pastMidnight.endedAt },
      { start: logged.startedAt, end: logged.endedAt },
    ]);
    expect(win.meetingsByDate.get('2026-11-07')).toEqual([]);
  });
});
