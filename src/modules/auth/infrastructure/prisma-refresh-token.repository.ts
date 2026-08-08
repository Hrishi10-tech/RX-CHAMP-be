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
    const current = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.hash(rawToken) },
    });

    // Unknown, already revoked, or expired → reject (caller → 401).
    if (!current || current.revokedAt || current.expiresAt <= new Date()) {
      return null;
    }

    const token = this.generateRawToken();
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.prisma.$transaction(async (tx) => {
      const next = await tx.refreshToken.create({
        data: {
          userId: current.userId,
          tokenHash: this.hash(token),
          expiresAt,
          userAgent: meta.userAgent,
          ip: meta.ip,
        },
      });
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { revokedAt: new Date(), replacedById: next.id },
      });
    });

    return { userId: current.userId, token, expiresAt };
  }

  async revoke(rawToken: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
