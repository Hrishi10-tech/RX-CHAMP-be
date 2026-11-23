import { PrismaPushRepository } from './prisma-push.repository';

function setup(stale: string[] = []) {
  const pushDevice = {
    upsert: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue(stale.map((id) => ({ id }))),
    deleteMany: jest.fn().mockResolvedValue({ count: stale.length }),
  };
  return { repo: new PrismaPushRepository({ pushDevice } as never), pushDevice };
}

describe('PrismaPushRepository (3.6)', () => {
  describe('one person holds a handful of phones, not thousands', () => {
    it('keeps their newest 10 and forgets the rest', async () => {
      const { repo, pushDevice } = setup(['old-1', 'old-2']);
      await repo.saveDevice('u1', 'token', 'android');
      expect(pushDevice.upsert).toHaveBeenCalledTimes(1);
      expect(pushDevice.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: 10,
        select: { id: true },
      });
      expect(pushDevice.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-1', 'old-2'] } },
      });
      expect(pushDevice.upsert.mock.invocationCallOrder[0]).toBeLessThan(
        pushDevice.findMany.mock.invocationCallOrder[0],
      );
    });

    it('within the limit nothing is deleted', async () => {
      const { repo, pushDevice } = setup();
      await repo.saveDevice('u1', 'token', 'android');
      expect(pushDevice.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('removeDevices', () => {
    it("no token named: all of the person's phones", async () => {
      const { repo, pushDevice } = setup();
      await repo.removeDevices('u1');
      expect(pushDevice.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });
    });

    it('a token named: that one, even an empty one, never all of them', async () => {
      const { repo, pushDevice } = setup();
      await repo.removeDevices('u1', 'token');
      expect(pushDevice.deleteMany).toHaveBeenLastCalledWith({
        where: { userId: 'u1', token: 'token' },
      });
      await repo.removeDevices('u1', '');
      expect(pushDevice.deleteMany).toHaveBeenLastCalledWith({
        where: { userId: 'u1', token: '' },
      });
    });
  });
});
