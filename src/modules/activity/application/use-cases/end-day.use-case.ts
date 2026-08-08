import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { fullName } from '@shared/types/user.types';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { MEETING_WINDOW_READER, MeetingWindowReader } from '../../domain/meeting-window.reader';
import { DayEndedEvent } from '../../domain/events/day-ended.event';
import { ActivityGateway } from '../../presentation/activity.gateway';
import { ActivityMapper } from '../activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC, MAX_GAP_SEC } from '../activity.constants';
import { clamp, elapsedSeconds, localDateString } from '../activity-date.util';
import { EndDayResult } from '../activity.types';

/**
 * The agent's explicit "End Day" action. The day stops dead at this instant:
 *
 *  1. the trailing open sample is stamped up to `endedAt`, so nothing is left
 *     running and the active/idle totals become final;
 *  2. the day is marked ended, which flips `shouldCapture` off for the agent and
 *     turns the manager's board to DAY_ENDED;
 *  3. {@link DayEndedEvent} tells presence to close attendance at the same
 *     instant, and notifications to tell the manager.
 *
 * Idempotent — pressing it again returns the original end time and fires nothing.
 */
@Injectable()
export class EndDayUseCase {
  private readonly logger = new Logger(EndDayUseCase.name);

  constructor(
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly samples: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
    @Inject(MEETING_WINDOW_READER) private readonly meetings: MeetingWindowReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly gateway: ActivityGateway,
  ) {}

  async execute(userId: string, at: Date = new Date()): Promise<EndDayResult> {
    const date = localDateString(at);
    const { record, created } = await this.workDays.markEnded(userId, date, at);

    // A repeat press must not move the line: everything below already ran, and
    // re-running it against a later `at` would re-open the frozen totals.
    if (!created) {
      return { ok: true, date: record.date, endedAt: record.endedAt.toISOString() };
    }

    await this.closeTrailingSample(userId, record.endedAt);
    await this.announce(userId, date, record.endedAt);

    return { ok: true, date: record.date, endedAt: record.endedAt.toISOString() };
  }

  /**
   * Stamps the still-open final sample with its duration up to the End Day
   * instant. Without this the rollup keeps crediting that sample against the
   * wall clock (up to {@link MAX_GAP_SEC}) long after the user signed off.
   */
  private async closeTrailingSample(userId: string, endedAt: Date): Promise<void> {
    const last = await this.samples.findLatestForUser(userId);
    if (!last || last.durationSec > 0 || last.at > endedAt) return;

    const dur = clamp(elapsedSeconds(last.at, endedAt), 0, MAX_GAP_SEC);
    if (dur > 0) await this.samples.stampDuration(last.id, dur);
  }

  /**
   * Pushes the final state to the user's own dashboard and their manager's board,
   * then raises the domain event. The board must flip on the click — no samples
   * follow, so waiting for the next one would leave it stale for minutes.
   * Best-effort: a broadcast failure must never fail the agent's End Day.
   */
  private async announce(userId: string, date: string, endedAt: Date): Promise<void> {
    try {
      const self = await this.access.findSelf(userId);
      const samples = await this.samples.listForUserByDate(userId, date);
      const meetings = await this.meetings.listForUserByDate(userId, date);
      const daily = ActivityMapper.computeDaily(
        samples,
        date,
        DEFAULT_WORKING_BASIS_SEC,
        endedAt,
        endedAt,
        meetings,
      );

      const current = ActivityMapper.toCurrentView(null, endedAt, true);
      this.gateway.emitToUser(userId, ActivityMapper.toMyUpdate(current, daily));

      if (self?.managerId) {
        this.gateway.emitToManager(
          self.managerId,
          ActivityMapper.toLiveUpdate(self, null, daily, endedAt, true),
        );
      }

      await this.events.publish(
        DayEndedEvent.eventName,
        new DayEndedEvent(
          userId,
          self ? fullName(self) : 'A team member',
          self?.managerId ?? null,
          date,
          endedAt,
        ),
      );
    } catch (err) {
      this.logger.warn(`end-day announce failed for ${userId}: ${(err as Error).message}`);
    }
  }
}
