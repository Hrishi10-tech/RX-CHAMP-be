import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { appTimezone } from '@shared/utils/timezone';
import { CompOffService } from './compoff.service';

/** Comp off (3.5): a week before a credit lapses, the person is told (09:20 business time). */
@Injectable()
export class CompOffJobs {
  private readonly logger = new Logger(CompOffJobs.name);

  constructor(private readonly compOff: CompOffService) {}

  @Cron('20 9 * * *', { name: 'compoff-expiry-notices', timeZone: appTimezone() })
  async expiring(): Promise<void> {
    try {
      const n = await this.compOff.remindExpiring(new Date());
      if (n) this.logger.log(`comp off lapse notices: ${n}`);
    } catch (err) {
      this.logger.warn(`comp off lapse notices failed: ${(err as Error).message}`);
    }
  }
}
