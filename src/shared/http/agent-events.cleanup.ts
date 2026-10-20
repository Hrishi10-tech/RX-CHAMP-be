import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@shared/database/prisma.service';
import { appTimezone } from '@shared/utils/timezone';

/** Replayed agent events are kept 30 days (a journal never holds older ones). */
const KEEP_MS = 30 * 24 * 3_600_000;

@Injectable()
export class AgentEventsCleanup {
  private readonly logger = new Logger(AgentEventsCleanup.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron('40 3 * * *', { name: 'agent-events-cleanup', timeZone: appTimezone() })
  async run(now: Date = new Date()): Promise<number> {
    try {
      const res = await this.prisma.agentEvent.deleteMany({
        where: { receivedAt: { lt: new Date(now.getTime() - KEEP_MS) } },
      });
      if (res.count) this.logger.log(`removed ${res.count} old agent event(s)`);
      return res.count;
    } catch (err) {
      this.logger.warn(`agent events cleanup failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
