import { randomBytes, createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/database/prisma.service';
import { CACHE_SERVICE, CacheService } from '@shared/cache/cache.port';
import { parseDurationMs } from '@shared/utils/duration';
import {
  IssuedRefreshToken,
  RefreshTokenMeta,
  RefreshTokenRepository,
  RotatedRefreshToken,
} from '../domain/refresh-token.repository';

/**
 * How long after a rotation the old token still buys a replacement. Clients run
 * several request loops against one cookie jar, so a short access-token TTL makes
 * them refresh simultaneously; within this window that is treated as the race it
 * is rather than as token theft.
 */
const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * How far a rotation chain is followed to find its newest token. A real race is
 * one or two links long; a chain longer than this inside the grace is refused.
 */
const MAX_CHAIN_HOPS = 20;

@Injectable()
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(CACHE_SERVICE) private readonly cache: CacheService,
  ) {}

  /** Where a freshly minted token waits for the losers of its own race. */
  private replayKey(oldTokenHash: string): string {
    return `refresh:replay:${oldTokenHash}`;
  }

  private get ttlMs(): number {
    return parseDurationMs(this.config.get<string>('jwt.refreshTtl') ?? '7d');
  }

  private generateRawToken(): string {
    return randomBytes(32).toString('hex');
  }

  private hash(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  async issue(userId: string, meta: RefreshTokenMeta): Promise<IssuedRefreshToken> {
    const token = this.generateRawToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        expiresAt,
        userAgent: meta.userAgent,
        ip: meta.ip,
      },
    });

    return { token, expiresAt };
  }

  async rotate(rawToken: string, meta: RefreshTokenMeta): Promise<RotatedRefreshToken | null> {
    const tokenHash = this.hash(rawToken);
    const now = new Date();

    // Claim the token before minting anything. `revokedAt: null` in the WHERE makes
    // this a compare-and-set, so of several refreshes arriving together exactly one
    // wins. The old read-then-write let them all pass the validity check and each
    // mint a successor from the same token — every loser then held a token the
    // winner had already revoked, which is how a session died mid-day.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now },
    });

    const current = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!current) return null; // unknown token

    if (claimed.count === 0) {
      return this.tolerateRace(current, tokenHash, now, meta);
    }

    const token = this.generateRawToken();
    const expiresAt = new Date(now.getTime() + this.ttlMs);

    try {
      const next = await this.prisma.refreshToken.create({
        data: {
          userId: current.userId,
          tokenHash: this.hash(token),
          expiresAt,
          userAgent: meta.userAgent,
          ip: meta.ip,
        },
      });
      await this.prisma.refreshToken.update({
        where: { id: current.id },
        data: { replacedById: next.id },
      });

      // Hold the new token where the losers of this same race will look for it, for
      // as long as their old one is still tolerated. Best-effort: if the cache is
      // unavailable they fall back to being issued one of their own, which is what
      // they got before this existed.
      try {
        await this.cache.set(
          this.replayKey(tokenHash),
          { token, expiresAt: expiresAt.toISOString() },
          Math.ceil(REFRESH_REUSE_GRACE_MS / 1000),
        );
      } catch {
        /* the fallback in tolerateRace covers this */
      }
    } catch (err) {
      // The claim already revoked the old token; if the successor never landed the
      // caller would be signed out for good. Hand the token back so a retry works.
      await this.prisma.refreshToken.update({
        where: { id: current.id },
        data: { revokedAt: null },
      });
      throw err;
    }

    return { userId: current.userId, token, expiresAt };
  }

  /**
   * A token we could not claim. Expired or revoked by logout → reject. But a token
   * rotated moments ago belongs to the loser of a concurrent refresh, not to someone
   * replaying a stolen one.
   *
   * That holds only while the session it was rotated into is still alive. If the
   * newest token of the chain was revoked since (a logout, a sign-out everywhere, a
   * block) or has expired, the session is over and the old token buys nothing:
   * otherwise a token rotated just before a sign-out would mint an access token
   * after it.
   *
   * The loser is handed the very token the winner was given, not one of its own.
   * Minting a second was the whole problem: each race left an extra live session
   * behind, every session refreshes on its own timer, and more sessions raced more
   * often — one user reached six live sessions and three forced sign-ins in an
   * afternoon. Replaying the winner's token keeps one session one session, which is
   * what the client believed it had all along.
   */
  private async tolerateRace(
    current: { userId: string; revokedAt: Date | null; replacedById: string | null },
    tokenHash: string,
    now: Date,
    meta: RefreshTokenMeta,
  ): Promise<RotatedRefreshToken | null> {
    const rotatedJustNow =
      current.revokedAt !== null &&
      current.replacedById !== null &&
      now.getTime() - current.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS;

    if (!rotatedJustNow) return null;
    if (!(await this.chainStillLive(current.replacedById, now))) return null;

    const replayed = await this.cache.get<{ token: string; expiresAt: string }>(
      this.replayKey(tokenHash),
    );
    if (replayed) {
      return {
        userId: current.userId,
        token: replayed.token,
        expiresAt: new Date(replayed.expiresAt),
      };
    }

    // The winner's token is no longer held — it fell out of the cache, or the
    // process that minted it has gone. A session the caller can use beats none, so
    // fall back to issuing one; this is the old behaviour, now the exception rather
    // than the rule.
    const issued = await this.issue(current.userId, meta);
    return { userId: current.userId, token: issued.token, expiresAt: issued.expiresAt };
  }

  /**
   * Follows `replacedById` from a successor to the newest token of its chain and
   * says whether that one can still be used. A successor that was itself rotated
   * is followed, so the losers of back-to-back races are still tolerated. Revoked
   * with no successor is the mark of logout and revokeAllForUser; for the few
   * milliseconds a rotation is in flight it is also what the token being rotated
   * looks like, and refusing then fails closed.
   */
  private async chainStillLive(successorId: string | null, now: Date): Promise<boolean> {
    let id = successorId;
    for (let hop = 0; id !== null && hop < MAX_CHAIN_HOPS; hop += 1) {
      const row = await this.prisma.refreshToken.findUnique({
        where: { id },
        select: { revokedAt: true, replacedById: true, expiresAt: true },
      });
      if (!row) return false;
      if (row.revokedAt === null) return row.expiresAt.getTime() > now.getTime();
      id = row.replacedById;
    }
    return false;
  }

  async purgeDead(cutoff: Date): Promise<number> {
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
      },
    });
    return count;
  }

  async signedInFrom(userId: string, ip: string, since: Date): Promise<boolean> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { userId, ip, createdAt: { gte: since } },
      select: { id: true },
    });
    return row !== null;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async revokeAgentSessions(userId: string): Promise<number> {
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null, userAgent: { startsWith: 'RXVisionAgent/' } },
      data: { revokedAt: new Date() },
    });
    return count;
  }

  async revoke(rawToken: string): Promise<void> {
    const tokenHash = this.hash(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.forgetReplayOf(tokenHash);
  }

  /**
   * Logout: the token just revoked may still be waiting in the replay cache under
   * the token it replaced. tolerateRace already refuses that chain; this stops a
   * signed-out refresh token sitting in memory for the rest of the grace. Best
   * effort, like the write that put it there.
   */
  private async forgetReplayOf(tokenHash: string): Promise<void> {
    try {
      const row = await this.prisma.refreshToken.findUnique({
        where: { tokenHash },
        select: { id: true },
      });
      if (!row) return;
      const predecessors = await this.prisma.refreshToken.findMany({
        where: { replacedById: row.id },
        select: { tokenHash: true },
      });
      for (const predecessor of predecessors) {
        await this.cache.del(this.replayKey(predecessor.tokenHash));
      }
    } catch {
      /* the chain check in tolerateRace is what refuses the replay */
    }
  }
}
