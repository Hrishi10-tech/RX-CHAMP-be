import { PrismaLeaveRepository } from './prisma-leave.repository';

const ORG = '11111111-1111-4111-8111-111111111111';

function setup() {
  const prisma = {
    leaveRequest: { findMany: jest.fn().mockResolvedValue([]) },
    compOffCredit: { findMany: jest.fn().mockResolvedValue([]) },
    monthLock: { findMany: jest.fn().mockResolvedValue([{ companyId: ORG, month: '2026-10' }]) },
  };
  return { repo: new PrismaLeaveRepository(prisma as never), prisma };
}

const DECIDED = [{ decidedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }];

describe('PrismaLeaveRepository (3.6)', () => {
  it('leave reads latest decision first when asked, and newest asked for otherwise', async () => {
    const { repo, prisma } = setup();
    await repo.listRequests({ order: 'DECIDED', limit: 50 });
    expect(prisma.leaveRequest.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: DECIDED,
      take: 50,
    });
    await repo.listRequests({});
    expect(prisma.leaveRequest.findMany.mock.calls[1][0].orderBy).toEqual([{ createdAt: 'desc' }]);
    await repo.listRequests({ order: 'SOONEST' });
    expect(prisma.leaveRequest.findMany.mock.calls[2][0].orderBy).toEqual([
      { startDate: 'asc' },
      { createdAt: 'asc' },
    ]);
  });

  it('comp off the same way', async () => {
    const { repo, prisma } = setup();
    await repo.listCredits({ order: 'DECIDED', limit: 50 });
    expect(prisma.compOffCredit.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: DECIDED,
      take: 50,
    });
    await repo.listCredits({});
    expect(prisma.compOffCredit.findMany.mock.calls[1][0].orderBy).toEqual([{ createdAt: 'desc' }]);
  });

  it('4.0: says which of these months are locked, per organisation', async () => {
    const { repo, prisma } = setup();
    await expect(repo.lockedMonths([ORG, ORG], ['2026-10', '2026-11', '2026-10'])).resolves.toEqual(
      new Set([`${ORG}|2026-10`]),
    );
    expect(prisma.monthLock.findMany.mock.calls[0][0].where).toEqual({
      month: { in: ['2026-10', '2026-11'] },
      companyId: { in: [ORG] },
    });
  });

  it('asks nothing when no month or no organisation is named', async () => {
    const { repo, prisma } = setup();
    await expect(repo.lockedMonths([ORG], [])).resolves.toEqual(new Set());
    await expect(repo.lockedMonths([], ['2026-10'])).resolves.toEqual(new Set());
    // Someone outside any organisation (or a bad id) is never locked.
    await expect(repo.lockedMonths(['', 'not-an-id'], ['2026-10'])).resolves.toEqual(new Set());
    expect(prisma.monthLock.findMany).not.toHaveBeenCalled();
  });
});
