import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { MEETING_WINDOW_READER, MeetingWindowReader } from '../../domain/meeting-window.reader';
import { ActivityGateway } from '../../presentation/activity.gateway';
import { ActivityMapper } from '../activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC } from '../activity.constants';
import { localDateString } from '../activity-date.util';
import { StartDayResult } from '../activity.types';

/**
 * Reverses "End Day" so the user can resume the same day (the agent's "Start day"
 * button). Clears today's end mark, which immediately re-enables activity
 * sampling, screenshots and attendance (heartbeat / presence all read the end
 * mark live), and flips the manager's board back off DAY_ENDED.
 *
 * Idempotent — starting an already-open day does nothing. The agent restarts its
 * own timers on success and sends a fresh sample right away, so live status
 * catches up within a second.
 */
@Injectable()
export class StartDayUseCase {
  private readonly logger = new Logger(StartDayUseCase.name);

  constructor(
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly samples: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
    @Inject(MEETING_WINDOW_READER) private readonly meetings: MeetingWindowReader,
    private readonly gateway: ActivityGateway,
  ) {}

  async execute(userId: string, at: Date = new Date()): Promise<StartDayResult> {
    const date = localDateString(at);
    const resumed = await this.workDays.clearEnd(userId, date);

    // Only announce when something actually changed.
    if (resumed) await this.announce(userId, date, at);

    return { ok: true, date, resumed };
  }

  /**
   * Pushes the now-live state to the user's own dashboard and their manager's
   * board so both drop DAY_ENDED at once, rather than waiting for the agent's
   * first fresh sample. Best-effort — a broadcast failure must never fail the
   * agent's Start Day.
   */
  private async announce(userId: string, date: string, now: Date): Promise<void> {
    try {
      const self = await this.access.findSelf(userId);
      const samples = await this.samples.listForUserByDate(userId, date);
      const meetings = await this.meetings.listForUserByDate(userId, date);
      const daily = ActivityMapper.computeDaily(
        samples,
        date,
        DEFAULT_WORKING_BASIS_SEC,
        now,
        null, // day is open again
        meetings,
      );

      const latest = await this.samples.findLatestForUser(userId);
      const current = ActivityMapper.toCurrentView(latest, now, false);
      this.gateway.emitToUser(userId, ActivityMapper.toMyUpdate(current, daily));

      if (self?.managerId) {
        this.gateway.emitToManager(
          self.managerId,
          ActivityMapper.toLiveUpdate(self, latest, daily, now, false),
        );
      }
    } catch (err) {
      this.logger.warn(`start-day announce failed for ${userId}: ${(err as Error).message}`);
    }
  }
}
