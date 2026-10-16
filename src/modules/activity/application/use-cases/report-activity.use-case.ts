import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ACTIVITY_SAMPLE_REPOSITORY,
  ActivitySampleRecord,
  ActivitySampleRepository,
} from '../../domain/activity-sample.repository';
import {
  ACTIVITY_ACCESS_READER,
  ActivityAccessReader,
  ActivitySelf,
} from '../../domain/activity-access.reader';
import { WORK_DAY_REPOSITORY, WorkDayRepository } from '../../domain/work-day.repository';
import { MEETING_WINDOW_READER, MeetingWindowReader } from '../../domain/meeting-window.reader';
import { ActivityGateway } from '../../presentation/activity.gateway';
import { ReportActivityDto } from '../dto';
import { ActivityMapper } from '../activity.mapper';
import { myUpdateFor } from '../activity-redaction';
import { DEFAULT_WORKING_BASIS_SEC, LOCK_SCREEN_APP, MAX_GAP_SEC } from '../activity.constants';
import { ActivityAck, DailyActivityView } from '../activity.types';
import { clamp, elapsedSeconds, localDateString } from '../activity-date.util';

/** A sample stamped this far ahead of the server clock is taken as "now". */
const MAX_FUTURE_SKEW_MS = 2 * 60_000;
/** Offline backlog older than this is acknowledged but not stored. */
const MAX_BACKLOG_MS = 72 * 60 * 60_000;

/**
 * The instant a sample is filed under: the agent's stamp, unless it is not a
 * date or lies further in the future than the allowed skew (then now).
 */
export function sampleInstant(raw: string | undefined, now: Date): Date {
  const at = raw ? new Date(raw) : now;
  if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) return now;
  return at;
}

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
    // The agent stamps each sample and may replay an offline backlog, so a past
    // `at` is legitimate; a future one (a wrong PC clock, or a forged report) is
    // never trusted past a small skew, and ancient backlog is not stored.
    const now = new Date();
    const at = sampleInstant(body.at, now);
    const stale = now.getTime() - at.getTime() > MAX_BACKLOG_MS;
    const date = localDateString(stale ? now : at);

    // The day's totals are final once it has been ended, so a late report — an
    // in-flight sample, or an agent restarted after signing off — is acknowledged
    // but never stored. Answering with shouldCapture=false stops the agent again.
    // Fetched once and reused: the ack needs the screenshot switch, and the live
    // broadcast below needs the same row's name + manager.
    const self = await this.access.findSelf(userId);
    const screenshotsEnabled = self?.screenshotsEnabled ?? true;

    const end = await this.workDays.findEnd(userId, date);
    if (end) {
      // Never stored. What the agent should do now depends on today, not on the
      // sample's day: yesterday's leftovers (queued while offline, sent this
      // morning) must not stop today's tracking.
      const today = localDateString(now);
      const todayEnded = date === today ? true : !!(await this.workDays.findEnd(userId, today));
      return this.endedAck(userId, date, end.endedAt, screenshotsEnabled, todayEnded);
    }
    if (stale) return this.progressAck(userId, date, now, screenshotsEnabled);

    // Close the previous open sample: it was foreground until this one arrived.
    const prev = await this.repo.findLatestForUser(userId);
    if (prev && prev.durationSec === 0 && prev.at <= at) {
      const dur = clamp(elapsedSeconds(prev.at, at), 0, MAX_GAP_SEC);
      if (dur > 0) await this.repo.stampDuration(prev.id, dur);
    }

    const app = this.trim(body.app, 200);
    // An agent that never sends `locked` still gives the lock screen away by name, and
    // that is the state the whole report hangs on — so believe either source.
    const locked = (body.locked ?? false) || app === LOCK_SCREEN_APP;
    const idle = (body.idle ?? false) || locked;
    const created = await this.repo.create({
      userId,
      date,
      at,
      // Locked always counts as idle, whatever the agent computed — so a report that
      // sets only `locked` still lands in the idle column.
      idle,
      locked,
      app,
      title: this.trim(body.title, 500),
      url: this.trim(body.url, 255),
    });

    // Login time = the first ACTIVE report of the local day — the first time the
    // user actually used the PC. Only active reports count, so a machine left on
    // and idle overnight (no End Day) doesn't record 12:00 AM as the login; the
    // real morning arrival does. First write wins; resets cleanly each day.
    if (!idle) await this.workDays.recordLogin(userId, date, at);
    const login = await this.workDays.findLogin(userId, date);

    const basis = DEFAULT_WORKING_BASIS_SEC;
    const daySamples = await this.repo.listForUserByDate(userId, date);
    const meetings = await this.meetings.listForUserByDate(userId, date);
    const daily = ActivityMapper.computeDaily(daySamples, date, basis, at, null, meetings, login);

    // Push live: the user's own dashboard, and their manager's team board.
    // Best-effort — a broadcast failure must never fail the agent's report.
    await this.broadcast(userId, created, daily, at, login, self);

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
      // Separate switch: stops the periodic capture only, never the tracking.
      screenshotsEnabled,
    };
  }

  /**
   * 3.1: a sample from a 3.1 agent with no open work session is not stored (the
   * agent tracks nothing before Start Day). Answers with today's progress so far,
   * `shouldCapture: false`, and whether today was ended.
   */
  async ackWithoutStoring(userId: string, now: Date): Promise<ActivityAck> {
    const self = await this.access.findSelf(userId);
    const date = localDateString(now);
    const end = await this.workDays.findEnd(userId, date);
    const basis = DEFAULT_WORKING_BASIS_SEC;
    const daySamples = await this.repo.listForUserByDate(userId, date);
    const meetings = await this.meetings.listForUserByDate(userId, date);
    const login = await this.workDays.findLogin(userId, date);
    const daily = ActivityMapper.computeDaily(
      daySamples,
      date,
      basis,
      now,
      end?.endedAt ?? null,
      meetings,
      login,
    );
    return {
      ok: true,
      activeSec: daily.activeSec,
      workingBasisSec: basis,
      remainingSec: daily.remainingSec,
      clockedOut: daily.clockedOut,
      dayEnded: end !== null,
      shouldCapture: false,
      screenshotsEnabled: self?.screenshotsEnabled ?? true,
    };
  }

  /** Ack without storing (a sample too old to keep): today's progress so far. */
  private async progressAck(
    userId: string,
    date: string,
    now: Date,
    screenshotsEnabled: boolean,
  ): Promise<ActivityAck> {
    const basis = DEFAULT_WORKING_BASIS_SEC;
    const daySamples = await this.repo.listForUserByDate(userId, date);
    const meetings = await this.meetings.listForUserByDate(userId, date);
    const login = await this.workDays.findLogin(userId, date);
    const daily = ActivityMapper.computeDaily(daySamples, date, basis, now, null, meetings, login);
    return {
      ok: true,
      activeSec: daily.activeSec,
      workingBasisSec: basis,
      remainingSec: daily.remainingSec,
      clockedOut: daily.clockedOut,
      dayEnded: false,
      shouldCapture: true,
      screenshotsEnabled,
    };
  }

  /**
   * Ack for a sample whose day is already over: that day's frozen totals, and
   * stop capturing only when today has been ended too.
   */
  private async endedAck(
    userId: string,
    date: string,
    endedAt: Date,
    screenshotsEnabled: boolean,
    todayEnded: boolean,
  ): Promise<ActivityAck> {
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
      dayEnded: todayEnded,
      shouldCapture: !todayEnded,
      screenshotsEnabled,
    };
  }

  private async broadcast(
    userId: string,
    created: ActivitySampleRecord,
    daily: DailyActivityView,
    now: Date,
    login: Date | null,
    self: ActivitySelf | undefined,
  ): Promise<void> {
    try {
      const current = ActivityMapper.toCurrentView(created, now);
      // Staff get the push without their activity figures (SPEC 1.8).
      this.gateway.emitToUser(
        userId,
        myUpdateFor(self?.role, ActivityMapper.toMyUpdate(current, daily)),
      );

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
