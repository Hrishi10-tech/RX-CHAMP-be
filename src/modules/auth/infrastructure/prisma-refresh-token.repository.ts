import { randomBytes, createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@shared/database/prisma.service';
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

@Injectable()
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

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
      return this.tolerateRace(current, now, meta);
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
   * replaying an old one: issue it a fresh token so every racer ends up holding a
   * working session instead of one of them going quietly dead.
   */
  private async tolerateRace(
    current: { userId: string; revokedAt: Date | null; replacedById: string | null },
    now: Date,
    meta: RefreshTokenMeta,
  ): Promise<RotatedRefreshToken | null> {
    const rotatedJustNow =
      current.revokedAt !== null &&
      current.replacedById !== null &&
      now.getTime() - current.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS;

    if (!rotatedJustNow) return null;

    const issued = await this.issue(current.userId, meta);
    return { userId: current.userId, token: issued.token, expiresAt: issued.expiresAt };
  }

  async revoke(rawToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
