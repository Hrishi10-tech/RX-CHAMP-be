import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { appTimezone } from '@shared/utils/timezone';
import { BiometricDaysService } from './biometric-days.service';
import { BiometricPullService } from './biometric-pull.service';

/** Biometric jobs (3.5): days with no check-out close; the pull adapter reads when due. */
@Injectable()
export class BiometricJobs {
  private readonly logger = new Logger(BiometricJobs.name);
  private closing = false;

  constructor(
    private readonly days: BiometricDaysService,
    private readonly pull: BiometricPullService,
  ) {}

  @Cron('*/10 * * * *', { name: 'biometric-close-days', timeZone: appTimezone() })
  async closeDays(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.days.closeDue(new Date());
    } catch (err) {
      this.logger.warn(`closing biometric days failed: ${(err as Error).message}`);
    } finally {
      this.closing = false;
    }
  }

  @Cron('* * * * *', { name: 'biometric-pull', timeZone: appTimezone() })
  async pullTick(): Promise<void> {
    try {
      await this.pull.tick(new Date());
    } catch (err) {
      // A run already in progress, or a failure the pull state records.
      this.logger.debug?.(`biometric pull tick: ${(err as Error).message}`);
    }
  }
}
