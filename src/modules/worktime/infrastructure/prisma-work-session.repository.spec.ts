import { PrismaWorkSessionRepository } from './prisma-work-session.repository';

/**
 * The writes of the automatic close and of a late input's move, against a fake
 * transaction (re-audit M2, M5, L3).
 */
const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const at = (iso: string) => new Date(iso);

function fakeTx(session: { endReason: string | null; startedAt: Date } | null) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    workSession: {
      findFirst: jest.fn().mockResolvedValue(session),
      update: jest.fn(async ({ data }: { data: object }) => ({
        id: 's1',
        userId: USER,
        date: '2026-10-19',
        startedAt: session?.startedAt,
        endedAt: null,
        endReason: null,
        source: 'AGENT',
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    presenceSession: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn() },
    breakRecord: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    workDayEnd: {
      createMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma = { $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { repo: new PrismaWorkSessionRepository(prisma as never), tx };
}

const session = {
  id: 's1',
  userId: USER,
  date: '2026-10-19',
  startedAt: at('2026-10-19T03:30:00Z'),
  endedAt: null,
  endReason: null,
  source: 'AGENT',
} as never;

describe('PrismaWorkSessionRepository.autoClose', () => {
  it('drops the auto-skips after the close, never a decided one', async () => {
    const { repo, tx } = fakeTx({ endReason: null, startedAt: at('2026-10-19T03:30:00Z') });
    const res = await repo.autoClose(session, at('2026-10-19T04:30:00Z'));
    expect(res).toMatchObject({ closed: true, reclosed: false });
    expect(tx.breakRecord.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        outcome: 'AUTO_SKIPPED',
        scheduledStart: { gt: at('2026-10-19T04:30:00Z') },
        approvalStatus: { notIn: ['APPROVED', 'REJECTED'] },
      }),
    });
  });

  it('a session auto-closed before (reopened by a replay) closes again as a re-close', async () => {
    const { repo } = fakeTx({ endReason: 'AUTO_CLOSED', startedAt: at('2026-10-19T03:30:00Z') });
    expect(await repo.autoClose(session, at('2026-10-19T04:30:00Z'))).toMatchObject({
      closed: true,
      reclosed: true,
    });
  });

  it('never closes before the start; closed meanwhile is no close', async () => {
    const { repo, tx } = fakeTx({ endReason: null, startedAt: at('2026-10-19T03:30:00Z') });
    await repo.autoClose(session, at('2026-10-19T03:00:00Z'));
    expect(tx.workSession.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { endedAt: at('2026-10-19T03:30:00Z'), endReason: 'AUTO_CLOSED' },
    });
    const gone = fakeTx(null);
    expect(await gone.repo.autoClose(session, at('2026-10-19T04:30:00Z'))).toMatchObject({
      closed: false,
    });
    expect(gone.tx.workSession.update).not.toHaveBeenCalled();
  });
});

describe('PrismaWorkSessionRepository.extendAutoClosed (re-audit M5)', () => {
  it('a moved close makes the session a REPLAY one, so the evidence rule applies', async () => {
    const { repo, tx } = fakeTx(null);
    const closed = {
      ...(session as object),
      endedAt: at('2026-10-19T04:30:00Z'),
      endReason: 'AUTO_CLOSED',
    } as never;
    expect(await repo.extendAutoClosed(closed, at('2026-10-19T09:00:00Z'))).toBe(true);
    expect(tx.workSession.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', endReason: 'AUTO_CLOSED', endedAt: at('2026-10-19T04:30:00Z') },
      data: { endedAt: at('2026-10-19T09:00:00Z'), source: 'REPLAY' },
    });
  });
});
