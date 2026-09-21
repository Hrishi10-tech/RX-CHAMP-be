import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../../domain/refresh-token.repository';

/** How long a dead token is kept before it is swept up. */
const RETENTION_DAYS = 7;

/**
 * Deletes refresh tokens that can no longer authenticate anyone.
 *
 * Rotation writes a row every fifteen minutes per signed-in device and marks the
 * previous one revoked, so the table only ever grows: three months of it reached
 * 756,000 rows and 376 MB, of which 51 were live. It became the largest table in
 * the database by an order of magnitude, holding nothing anyone could use.
 *
 * A week of dead tokens is kept deliberately. Working out why an agent was signed
 * out means reading the rotation chain around the moment it happened, and that
 * history is the only record of it — a sweep that left nothing behind would save a
 * few megabytes and cost the ability to answer the question.
 */
@Injectable()
export class RefreshTokenCleanupJob {
  private readonly logger = new Logger(RefreshTokenCleanupJob.name);

  constructor(@Inject(REFRESH_TOKEN_REPOSITORY) private readonly tokens: RefreshTokenRepository) {}

  // Three in the morning: nobody is signing in, and a delete that takes a while
  // competes with nothing.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async sweep(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    try {
      const removed = await this.tokens.purgeDead(cutoff);
      if (removed > 0) {
        this.logger.log(`swept ${removed} refresh tokens dead before ${cutoff.toISOString()}`);
      }
    } catch (err) {
      // Housekeeping must never take the process with it: the next run tries again.
      this.logger.warn(`refresh token sweep failed: ${(err as Error).message}`);
    }
  }
}
