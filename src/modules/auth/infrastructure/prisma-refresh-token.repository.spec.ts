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
    create: jest.fn(),
    update: jest.fn(),
  };
  const prisma = { refreshToken } as any;
  const config = { get: jest.fn().mockReturnValue('7d') } as any;
  const meta = { userAgent: 'jest', ip: '127.0.0.1' };

  let repo: PrismaRefreshTokenRepository;
  beforeEach(() => {
    jest.clearAllMocks();
    repo = new PrismaRefreshTokenRepository(prisma, config);
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
    refreshToken.findUnique.mockResolvedValue(row({ agoMs: 500 }));
    refreshToken.create.mockResolvedValue({ id: 'rt-3' });

    const result = await repo.rotate('raw', meta);

    expect(result).toMatchObject({ userId: 'u-1' });
    expect(result!.token).toHaveLength(64);
    // A sibling is issued; the winner's token is left alone.
    expect(refreshToken.update).not.toHaveBeenCalled();
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
});
