import { PrismaMeetingWindowReader } from './prisma-meeting-window.reader';

process.env.APP_TIMEZONE = 'Asia/Kolkata';

type Row = { startedAt: Date; endedAt: Date | null; approvalStatus?: string; date?: string };
type Where = {
  date?: string;
  startedAt?: { lt: Date };
  endedAt?: { gt: Date };
  approvalStatus?: { not: string };
  OR?: { endedAt: null | { gt: Date } }[];
};
const ist = (date: string, hm: string) => new Date(`${date}T${hm}:00+05:30`);

/** Applies the query as PostgreSQL would, so a filter on the stored date would be seen. */
function fakePrisma(live: Row[], logged: Row[]) {
  const matches = (where: Where) => (r: Row) => {
    if (where.date !== undefined && r.date !== where.date) return false;
    if (where.startedAt?.lt && !(r.startedAt < where.startedAt.lt)) return false;
    if (where.endedAt?.gt && !(r.endedAt && r.endedAt > where.endedAt.gt)) return false;
    if (where.approvalStatus?.not && r.approvalStatus === where.approvalStatus.not) return false;
    if (where.OR) {
      const ok = where.OR.some(({ endedAt }) =>
        endedAt === null ? r.endedAt === null : !!r.endedAt && r.endedAt > endedAt.gt,
      );
      if (!ok) return false;
    }
    return true;
  };
  return {
    presenceSession: {
      findMany: jest.fn(async ({ where }: { where: Where }) => live.filter(matches(where))),
    },
    meetingRecord: {
      findMany: jest.fn(async ({ where }: { where: Where }) => logged.filter(matches(where))),
    },
  };
}

const read = (live: Row[], logged: Row[], date: string) =>
  new PrismaMeetingWindowReader(fakePrisma(live, logged) as never).listForUserByDate('u1', date);

describe('a day’s meetings are read by time, not by their stored date (D-22)', () => {
  const pastMidnight = {
    date: '2026-11-05',
    startedAt: ist('2026-11-05', '23:40'),
    endedAt: ist('2026-11-06', '00:30'),
  };

  it('a meeting past midnight is on both days', async () => {
    expect(await read([pastMidnight], [], '2026-11-05')).toHaveLength(1);
    expect(await read([pastMidnight], [], '2026-11-06')).toEqual([
      { start: pastMidnight.startedAt, end: pastMidnight.endedAt },
    ]);
    expect(await read([pastMidnight], [], '2026-11-07')).toEqual([]);
    expect(await read([pastMidnight], [], '2026-11-04')).toEqual([]);
  });

  it('one still running past midnight is on the new day', async () => {
    const running = { ...pastMidnight, endedAt: null };
    expect(await read([running], [], '2026-11-06')).toEqual([
      { start: running.startedAt, end: null },
    ]);
  });

  it('a logged meeting on a night shift is on the day its time falls on', async () => {
    const logged = {
      date: '2026-11-05',
      approvalStatus: 'PENDING',
      startedAt: ist('2026-11-06', '00:10'),
      endedAt: ist('2026-11-06', '00:40'),
    };
    expect(await read([], [logged], '2026-11-06')).toHaveLength(1);
    expect(await read([], [logged], '2026-11-05')).toEqual([]);
  });

  it('a logged meeting a manager rejected is not a meeting', async () => {
    const rejected = {
      date: '2026-11-06',
      approvalStatus: 'REJECTED',
      startedAt: ist('2026-11-06', '10:00'),
      endedAt: ist('2026-11-06', '10:30'),
    };
    expect(await read([], [rejected], '2026-11-06')).toEqual([]);
  });

  it('touching the day at its very edge is not overlapping it', async () => {
    const before = {
      date: '2026-11-05',
      startedAt: ist('2026-11-05', '23:00'),
      endedAt: ist('2026-11-06', '00:00'),
    };
    expect(await read([before], [], '2026-11-06')).toEqual([]);
  });
});
