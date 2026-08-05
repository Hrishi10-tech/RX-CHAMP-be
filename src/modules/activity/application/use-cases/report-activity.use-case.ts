import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRecord,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { ActivityGateway } from '../../presentation/activity.gateway';
import { ReportActivityDto } from '../dto';
import { ActivityMapper } from '../activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC, MAX_GAP_SEC } from '../activity.constants';
import { ActivityAck, DailyActivityView } from '../activity.types';
import { clamp, elapsedSeconds, localDateString } from '../activity-date.util';

/**
 * Ingests one foreground-activity sample from the agent. Stamps the previous
 * (open) sample with how long its app actually stayed foreground, then records
 * the new sample, and answers with the day's progress against the 9h basis.
 */
@Injectable()
export class ReportActivityUseCase {
  private readonly logger = new Logger(ReportActivityUseCase.name);

  constructor(
    @Inject(ACTIVITY_SAMPLE_REPOSITORY) private readonly repo: ActivitySampleRepository,
    @Inject(ACTIVITY_ACCESS_READER) private readonly access: ActivityAccessReader,
    @Inject(WORK_DAY_REPOSITORY) private readonly workDays: WorkDayRepository,
    private readonly gateway: ActivityGateway,
  ) {}

  async execute(userId: string, body: ReportActivityDto): Promise<ActivityAck> {
    const at = body.at ? new Date(body.at) : new Date();
    const date = localDateString(at);

    // Close the previous open sample: it was foreground until this one arrived.
    const prev = await this.repo.findLatestForUser(userId);
    if (prev && prev.durationSec === 0 && prev.at <= at) {
      const dur = clamp(elapsedSeconds(prev.at, at), 0, MAX_GAP_SEC);
      if (dur > 0) await this.repo.stampDuration(prev.id, dur);
    }

    const created = await this.repo.create({
      userId,
      date,
      at,
      // Locked always counts as idle, whatever the agent computed — so a report that
      // sets only `locked` still lands in the idle column.
      idle: (body.idle ?? false) || (body.locked ?? false),
      locked: body.locked ?? false,
      app: this.trim(body.app, 200),
      title: this.trim(body.title, 500),
      url: this.trim(body.url, 255),
    });

    const basis = DEFAULT_WORKING_BASIS_SEC;
    const daySamples = await this.repo.listForUserByDate(userId, date);
    const daily = ActivityMapper.computeDaily(daySamples, date, basis, at);

    // Capture runs for the whole working day (overtime + idle included) and stops
    // only once the user has explicitly ended the day.
    const dayEnded = (await this.workDays.findEnd(userId, date)) !== null;

    // Push live: the user's own dashboard, and their manager's team board.
    // Best-effort — a broadcast failure must never fail the agent's report.
    await this.broadcast(userId, created, daily, at);

    return {
      ok: true,
      activeSec: daily.activeSec,
      workingBasisSec: basis,
      remainingSec: daily.remainingSec,
      clockedOut: daily.clockedOut,
      dayEnded,
      shouldCapture: !dayEnded,
    };
  }

  private async broadcast(
    userId: string,
    created: ActivitySampleRecord,
    daily: DailyActivityView,
    now: Date,
  ): Promise<void> {
    try {
      const current = ActivityMapper.toCurrentView(created, now);
      this.gateway.emitToUser(userId, ActivityMapper.toMyUpdate(current, daily));

      const self = await this.access.findSelf(userId);
      if (self?.managerId) {
        this.gateway.emitToManager(
          self.managerId,
          ActivityMapper.toLiveUpdate(self, created, daily, now),
        );
      }
    } catch (err) {
      this.logger.warn(`activity broadcast failed for ${userId}: ${(err as Error).message}`);
    }
  }

  private trim(value: string | undefined, max: number): string | null {
    if (!value) return null;
    const v = value.trim();
    if (!v) return null;
    return v.length > max ? v.slice(0, max) : v;
  }
}
