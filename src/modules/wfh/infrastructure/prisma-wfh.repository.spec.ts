import { PrismaWfhRepository } from './prisma-wfh.repository';

const ORG = '11111111-1111-4111-8111-111111111111';

function setup() {
  const prisma = {
    wfhRequest: { findMany: jest.fn().mockResolvedValue([]) },
    monthLock: { findMany: jest.fn().mockResolvedValue([{ companyId: ORG, month: '2026-10' }]) },
  };
  return { repo: new PrismaWfhRepository(prisma as never), prisma };
}

describe('PrismaWfhRepository (3.6)', () => {
  it('reads latest decision first when asked, and newest asked for otherwise', async () => {
    const { repo, prisma } = setup();
    await repo.listRequests({ order: 'DECIDED', limit: 50 });
    expect(prisma.wfhRequest.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: [{ decidedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: 50,
    });
    await repo.listRequests({});
    expect(prisma.wfhRequest.findMany.mock.calls[1][0].orderBy).toEqual([{ createdAt: 'desc' }]);
  });

  it('4.0: says which of these months are locked, per organisation', async () => {
    const { repo, prisma } = setup();
    await expect(repo.lockedMonths([ORG], ['2026-10', '2026-11'])).resolves.toEqual(
      new Set([`${ORG}|2026-10`]),
    );
    expect(prisma.monthLock.findMany.mock.calls[0][0].where).toEqual({
      month: { in: ['2026-10', '2026-11'] },
      companyId: { in: [ORG] },
    });
    await expect(repo.lockedMonths([ORG], [])).resolves.toEqual(new Set());
  });
});
