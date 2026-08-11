import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRecord,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER, ActivityAccessReader } from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { MEETING_WINDOW_READER, MeetingWindowReader } from '../../domain/meeting-window.reader';
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
    @Inject(MEETING_WINDOW_READER) private readonly meetings: MeetingWindowReader,
    private readonly gateway: ActivityGateway,
  ) {}

  async execute(userId: string, body: ReportActivityDto): Promise<ActivityAck> {
    const at = body.at ? new Date(body.at) : new Date();
    const date = localDateString(at);

    // The day's totals are final once it has been ended, so a late report — an
    // in-flight sample, or an agent restarted after signing off — is acknowledged
    // but never stored. Answering with shouldCapture=false stops the agent again.
    const end = await this.workDays.findEnd(userId, date);
    if (end) return this.endedAck(userId, date, end.endedAt);

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

    // Record the PC login time (earliest per day wins), then read it back so the
    // day rollup + live board carry it.
    if (body.loginAt) await this.workDays.recordLogin(userId, date, new Date(body.loginAt));
    const login = await this.workDays.findLogin(userId, date);

    const basis = DEFAULT_WORKING_BASIS_SEC;
    const daySamples = await this.repo.listForUserByDate(userId, date);
    const meetings = await this.meetings.listForUserByDate(userId, date);
    const daily = ActivityMapper.computeDaily(daySamples, date, basis, at, null, meetings, login);

    // Push live: the user's own dashboard, and their manager's team board.
    // Best-effort — a broadcast failure must never fail the agent's report.
    await this.broadcast(userId, created, daily, at, login);

    return {
      ok: true,
      activeSec: daily.activeSec,
      workingBasisSec: basis,
      remainingSec: daily.remainingSec,
      clockedOut: daily.clockedOut,
      // Capture runs for the whole working day (overtime + idle included) and
      // stops only once the user has explicitly ended the day — handled above.
      dayEnded: false,
      shouldCapture: true,
    };
  }

  /** Ack for a day that is already over: the frozen totals, and stop capturing. */
  private async endedAck(userId: string, date: string, endedAt: Date): Promise<ActivityAck> {
    const basis = DEFAULT_WORKING_BASIS_SEC;
    const daySamples = await this.repo.listForUserByDate(userId, date);
    const meetings = await this.meetings.listForUserByDate(userId, date);
    const daily = ActivityMapper.computeDaily(daySamples, date, basis, endedAt, endedAt, meetings);

    return {
      ok: true,
      activeSec: daily.activeSec,
      workingBasisSec: basis,
      remainingSec: daily.remainingSec,
      clockedOut: daily.clockedOut,
      dayEnded: true,
      shouldCapture: false,
    };
  }

  private async broadcast(
    userId: string,
    created: ActivitySampleRecord,
    daily: DailyActivityView,
    now: Date,
    login: Date | null,
  ): Promise<void> {
    try {
      const current = ActivityMapper.toCurrentView(created, now);
      this.gateway.emitToUser(userId, ActivityMapper.toMyUpdate(current, daily));

      const self = await this.access.findSelf(userId);
      if (self?.managerId) {
        this.gateway.emitToManager(
          self.managerId,
          ActivityMapper.toLiveUpdate(self, created, daily, now, false, login),
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
