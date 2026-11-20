import { PrismaRefreshTokenRepository } from './prisma-refresh-token.repository';

/**
 * Rotation has to survive several request loops refreshing at the same instant —
 * an agent's activity, heartbeat, screenshot and chat loops all 401 together when
 * a short-lived access token expires. These tests pin the two properties that
 * matter: exactly one caller may mint a successor, and the losers still come away
 * with a usable token instead of a dead session.
 */
describe('PrismaRefreshTokenRepository.rotate', () => {
  const refreshToken = {
    updateMany: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const prisma = { refreshToken } as any;
  const config = { get: jest.fn().mockReturnValue('7d') } as any;
  const meta = { userAgent: 'jest', ip: '127.0.0.1' };

  // Empty by default, so a race with nothing held falls back to issuing — the
  // behaviour before the replay cache existed.
  const cache = { get: jest.fn(), set: jest.fn(), del: jest.fn(), delByPattern: jest.fn() } as any;

  let repo: PrismaRefreshTokenRepository;
  beforeEach(() => {
    jest.clearAllMocks();
    cache.get.mockResolvedValue(null);
    repo = new PrismaRefreshTokenRepository(prisma, config, cache);
  });

  /**
   * The presented token is looked up by its hash, the rest of its chain by id.
   * `chain` is what the rows after it look like now, keyed by id.
   */
  function stored(presented: object | null, chain: Record<string, object> = {}) {
    refreshToken.findUnique.mockImplementation(
      async ({ where }: { where: { id?: string; tokenHash?: string } }) =>
        where.id !== undefined ? (chain[where.id] ?? null) : presented,
    );
  }

  /** A token of the chain that is still usable. */
  const live = () => ({
    revokedAt: null,
    replacedById: null,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  /** A stored token row, revoked `agoMs` ago when `agoMs` is given. */
  function row(over: { agoMs?: number; replacedById?: string | null } = {}) {
    const revoked = over.agoMs === undefined ? null : new Date(Date.now() - over.agoMs);
    return {
      id: 'rt-1',
      userId: 'u-1',
      revokedAt: revoked,
      replacedById: over.replacedById === undefined ? 'rt-2' : over.replacedById,
      expiresAt: new Date(Date.now() + 86_400_000),
    };
  }

  it('claims the token with a revokedAt:null guard so only one caller can win', async () => {
    refreshToken.updateMany.mockResolvedValue({ count: 1 });
    refreshToken.findUnique.mockResolvedValue(row());
    refreshToken.create.mockResolvedValue({ id: 'rt-new' });

    const result = await repo.rotate('raw', meta);

    expect(result).toMatchObject({ userId: 'u-1' });
    expect(result!.token).toHaveLength(64);
    // The compare-and-set: unrevoked and unexpired, or nothing is claimed.
    expect(refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ revokedAt: null, expiresAt: expect.anything() }),
        data: expect.objectContaining({ revokedAt: expect.any(Date) }),
      }),
    );
    // Successor linked back, so a racing caller can be recognised as the loser.
    expect(refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { replacedById: 'rt-new' },
    });
  });

  it('gives a caller that lost the race a fresh working token', async () => {
    refreshToken.updateMany.mockResolvedValue({ count: 0 });
    stored(row({ agoMs: 500 }), { 'rt-2': live() });
    refreshToken.create.mockResolvedValue({ id: 'rt-3' });

    const result = await repo.rotate('raw', meta);

    expect(result).toMatchObject({ userId: 'u-1' });
    expect(result!.token).toHaveLength(64);
    // A sibling is issued; the winner's token is left alone.
    expect(refreshToken.update).not.toHaveBeenCalled();
  });

  it("hands the loser of a race the winner's token, not a second one", async () => {
    // The winner rotated moments ago and left its token where the loser can find it.
    cache.get.mockResolvedValue({
      token: 'the-winners-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    refreshToken.updateMany.mockResolvedValue({ count: 0 });
    stored(row({ agoMs: 500 }), { 'rt-2': live() });

    const result = await repo.rotate('raw', meta);

    expect(result!.token).toBe('the-winners-token');
    // The whole point: no extra session is created for the loser.
    expect(refreshToken.create).not.toHaveBeenCalled();
  });

  it('stores the new token for the losers of its own race', async () => {
    refreshToken.updateMany.mockResolvedValue({ count: 1 });
    refreshToken.findUnique.mockResolvedValue(row());
    refreshToken.create.mockResolvedValue({ id: 'rt-2' });

    const result = await repo.rotate('raw', meta);

    expect(cache.set).toHaveBeenCalledWith(
      expect.stringContaining('refresh:replay:'),
      expect.objectContaining({ token: result!.token }),
      expect.any(Number),
    );
  });

  it('rejects a token rotated long ago (replay, not a race)', async () => {
    refreshToken.updateMany.mockResolvedValue({ count: 0 });
    refreshToken.findUnique.mockResolvedValue(row({ agoMs: 5 * 60_000 }));

    await expect(repo.rotate('raw', meta)).resolves.toBeNull();
    expect(refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects a token revoked by logout (no successor to point at)', async () => {
    refreshToken.updateMany.mockResolvedValue({ count: 0 });
    refreshToken.findUnique.mockResolvedValue(row({ agoMs: 500, replacedById: null }));

    await expect(repo.rotate('raw', meta)).resolves.toBeNull();
    expect(refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    refreshToken.updateMany.mockResolvedValue({ count: 0 });
    refreshToken.findUnique.mockResolvedValue(null);

    await expect(repo.rotate('raw', meta)).resolves.toBeNull();
  });

  it('hands the claim back when the successor fails to land', async () => {
    refreshToken.updateMany.mockResolvedValue({ count: 1 });
    refreshToken.findUnique.mockResolvedValue(row());
    refreshToken.create.mockRejectedValue(new Error('db down'));

    await expect(repo.rotate('raw', meta)).rejects.toThrow('db down');
    // Otherwise the claim above would have signed the user out permanently.
    expect(refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'rt-1' },
      data: { revokedAt: null },
    });
  });

  /**
   * F-04: the grace is for the loser of a race in a session that is still alive.
   * Once the newest token of the chain is revoked (logout, sign out everywhere, a
   * block) or expired, the token rotated just before it buys nothing.
   */
  describe('the grace ends with the session', () => {
    const winnersToken = {
      token: 'the-winners-token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const revoked = (replacedById: string | null = null) => ({
      revokedAt: new Date(Date.now() - 100),
      replacedById,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    beforeEach(() => refreshToken.updateMany.mockResolvedValue({ count: 0 }));

    it("refuses the replay after a logout, though the winner's token is still cached", async () => {
      cache.get.mockResolvedValue(winnersToken);
      stored(row({ agoMs: 500 }), { 'rt-2': revoked() });

      await expect(repo.rotate('raw', meta)).resolves.toBeNull();
      expect(refreshToken.create).not.toHaveBeenCalled();
    });

    it('refuses after a logout on a cache miss too: no new session is issued', async () => {
      stored(row({ agoMs: 500 }), { 'rt-2': revoked() });

      await expect(repo.rotate('raw', meta)).resolves.toBeNull();
      expect(refreshToken.create).not.toHaveBeenCalled();
    });

    it('refuses when the chain was rotated again and then signed out', async () => {
      cache.get.mockResolvedValue(winnersToken);
      stored(row({ agoMs: 500 }), { 'rt-2': revoked('rt-3'), 'rt-3': revoked() });

      await expect(repo.rotate('raw', meta)).resolves.toBeNull();
    });

    it('refuses when the successor has expired or is gone', async () => {
      cache.get.mockResolvedValue(winnersToken);
      stored(row({ agoMs: 500 }), {
        'rt-2': { revokedAt: null, replacedById: null, expiresAt: new Date(Date.now() - 1) },
      });
      await expect(repo.rotate('raw', meta)).resolves.toBeNull();

      stored(row({ agoMs: 500 }), {});
      await expect(repo.rotate('raw', meta)).resolves.toBeNull();
      expect(refreshToken.create).not.toHaveBeenCalled();
    });

    it('control: a successor rotated again in a session that is still live is tolerated', async () => {
      cache.get.mockResolvedValue(winnersToken);
      stored(row({ agoMs: 500 }), { 'rt-2': revoked('rt-3'), 'rt-3': live() });

      const result = await repo.rotate('raw', meta);

      expect(result).toMatchObject({ userId: 'u-1', token: 'the-winners-token' });
    });

    it('gives up on a chain that never ends', async () => {
      cache.get.mockResolvedValue(winnersToken);
      refreshToken.findUnique.mockImplementation(async ({ where }: { where: { id?: string } }) =>
        where.id !== undefined ? revoked('rt-2') : row({ agoMs: 500 }),
      );

      await expect(repo.rotate('raw', meta)).resolves.toBeNull();
    });
  });

  describe('revoke (logout)', () => {
    it('revokes the token and forgets it where the losers of its race would find it', async () => {
      refreshToken.updateMany.mockResolvedValue({ count: 1 });
      refreshToken.findUnique.mockResolvedValue({ id: 'rt-2' });
      refreshToken.findMany.mockResolvedValue([{ tokenHash: 'hash-of-rt-1' }]);

      await repo.revoke('raw');

      expect(refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ revokedAt: null }),
          data: { revokedAt: expect.any(Date) },
        }),
      );
      expect(refreshToken.findMany).toHaveBeenCalledWith({
        where: { replacedById: 'rt-2' },
        select: { tokenHash: true },
      });
      expect(cache.del).toHaveBeenCalledWith('refresh:replay:hash-of-rt-1');
    });

    it('still signs out when the cache or the lookup fails', async () => {
      refreshToken.updateMany.mockResolvedValue({ count: 1 });
      refreshToken.findUnique.mockRejectedValue(new Error('db down'));

      await expect(repo.revoke('raw')).resolves.toBeUndefined();
      expect(refreshToken.updateMany).toHaveBeenCalledTimes(1);
    });
  });
});
