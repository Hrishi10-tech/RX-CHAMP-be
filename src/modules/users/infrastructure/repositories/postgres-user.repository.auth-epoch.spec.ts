import { PostgresUserRepository } from './postgres-user.repository';

const ID = '3f2b8c1e-5a44-4d0b-9c1a-7e6f5d4c3b2a';

describe('PostgresUserRepository: the auth epoch', () => {
  const user = { findFirst: jest.fn(), updateMany: jest.fn() };
  const repo = new PostgresUserRepository({ user } as never);

  beforeEach(() => jest.clearAllMocks());

  it('reads the epoch of an account that is not deleted', async () => {
    user.findFirst.mockResolvedValue({ authEpoch: 6 });

    await expect(repo.authEpochOf(ID)).resolves.toBe(6);
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { id: ID, deletedAt: null },
      select: { authEpoch: true },
    });
  });

  it('answers null for nobody, and for an id that is not one', async () => {
    user.findFirst.mockResolvedValue(null);
    await expect(repo.authEpochOf(ID)).resolves.toBeNull();

    await expect(repo.authEpochOf('not-an-id')).resolves.toBeNull();
    expect(user.findFirst).toHaveBeenCalledTimes(1);
  });

  it('raises it by one in the database, for a deleted account too', async () => {
    user.updateMany.mockResolvedValue({ count: 1 });

    await repo.raiseAuthEpoch(ID);

    // An increment, not a read and a write: two changes at once both count. No
    // deleted-at filter: a delete is one of the reasons to raise it.
    expect(user.updateMany).toHaveBeenCalledWith({
      where: { id: ID },
      data: { authEpoch: { increment: 1 } },
    });
  });
});
