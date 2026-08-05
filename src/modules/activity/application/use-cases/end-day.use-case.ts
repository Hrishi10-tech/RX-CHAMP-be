import { Inject, Injectable } from '@nestjs/common';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { localDateString } from '../activity-date.util';
import { EndDayResult } from '../activity.types';

/**
 * Handles the agent's explicit "End Day" action: marks the current local day
 * ended for the user so the agent stops capturing screenshots for the rest of
 * the day. Idempotent — pressing it again returns the original end time.
 */
@Injectable()
export class EndDayUseCase {
  constructor(
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
  ) {}

  async execute(userId: string, at: Date = new Date()): Promise<EndDayResult> {
    const date = localDateString(at);
    const record = await this.workDays.markEnded(userId, date, at);
    return { ok: true, date: record.date, endedAt: record.endedAt.toISOString() };
  }
}
