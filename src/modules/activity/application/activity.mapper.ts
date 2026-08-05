import { HourBucket, UsageEntry } from '@shared/types/common.types';
import { fullName } from '@shared/types/user.types';
import { ActivitySampleRecord } from '../domain/activity-sample.repository';
import { ActivityTeamMember } from '../domain/activity-access.reader';
import { clamp, elapsedSeconds, localDateString } from './activity-date.util';
import {
  IDLE_THRESHOLD_SEC,
  LIVE_GRACE_SEC,
  MAX_GAP_SEC,
  TOP_N,
} from './activity.constants';
import {
  ActivityStatus,
  CurrentActivityView,
  DailyActivityView,
  LiveActivityUpdate,
  MyActivityUpdate,
  TeamMemberActivityView,
} from './activity.types';

/** One sample's contribution to a day, with its seconds split active vs idle. */
interface DaySlice {
  hour: number;
  activeSec: number;
  idleSec: number;
  /** True when the agent itself flagged the sample idle (not backfilled). */
  flaggedIdle: boolean;
  /** Workstation locked: inactivity starts here, so there is no lead-in to reclaim. */
  locked: boolean;
  app: string | null;
  url: string | null;
}

export class ActivityMapper {
  /** Effective foreground seconds for a sample; the newest open one counts live. */
  static durationOf(
    sample: ActivitySampleRecord,
    isLatest: boolean,
    dayIsToday: boolean,
    now: Date,
  ): number {
    // A stamped, closed sample carries its own duration.
    if (sample.durationSec > 0) return clamp(sample.durationSec, 0, MAX_GAP_SEC);
    // The newest sample is still open: count time since it landed, but only for
    // today (a trailing open sample from a past day has an unknown tail → 0).
    if (isLatest && dayIsToday) return clamp(elapsedSeconds(sample.at, now), 0, MAX_GAP_SEC);
    return 0;
  }

  static statusOf(sample: ActivitySampleRecord | null, now: Date): ActivityStatus {
    if (!sample) return 'OFFLINE';
    if (elapsedSeconds(sample.at, now) > LIVE_GRACE_SEC) return 'OFFLINE';
    return sample.idle ? 'IDLE' : 'ACTIVE';
  }

  static toCurrentView(sample: ActivitySampleRecord | null, now: Date): CurrentActivityView {
    const status = this.statusOf(sample, now);
    if (!sample || status === 'OFFLINE') {
      return {
        status: 'OFFLINE',
        app: null,
        title: null,
        url: null,
        idle: false,
        lastSampleAt: sample ? sample.at.toISOString() : null,
        staleSec: sample ? elapsedSeconds(sample.at, now) : 0,
      };
    }
    return {
      status,
      app: sample.app,
      title: sample.title,
      url: sample.url,
      idle: sample.idle,
      lastSampleAt: sample.at.toISOString(),
      staleSec: elapsedSeconds(sample.at, now),
    };
  }

  static toTeamMemberView(
    member: ActivityTeamMember,
    sample: ActivitySampleRecord | null,
    now: Date,
  ): TeamMemberActivityView {
    const status = this.statusOf(sample, now);
    const live = sample && status !== 'OFFLINE';
    return {
      userId: member.id,
      name: fullName(member),
      email: member.email,
      department: member.department,
      status,
      app: live ? sample!.app : null,
      title: live ? sample!.title : null,
      url: live ? sample!.url : null,
      lastSampleAt: sample ? sample.at.toISOString() : null,
    };
  }

  /**
   * Rolls a day's samples up into totals, top apps/websites, an hourly split and
   * clock in/out. `samples` must be ordered by `at` ascending. When `endedAt` is
   * given (the user pressed "End Day"), it is used as the clock-out time instead
   * of the last sample's timestamp.
   */
  static computeDaily(
    samples: ActivitySampleRecord[],
    date: string,
    workingBasisSec: number,
    now: Date,
    endedAt: Date | null = null,
  ): DailyActivityView {
    const dayIsToday = date === localDateString(now);
    const hourly: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      activeSec: 0,
      idleSec: 0,
    }));
    const apps = new Map<string, number>();
    const sites = new Map<string, number>();

    let activeSec = 0;
    let idleSec = 0;

    // Split each sample's effective duration into active/idle seconds, then push
    // the pre-flag inactivity into the idle column before totalling anything up.
    const slices: DaySlice[] = [];
    samples.forEach((s, i) => {
      const dur = this.durationOf(s, i === samples.length - 1, dayIsToday, now);
      if (dur <= 0) return;
      slices.push({
        hour: s.at.getHours(),
        activeSec: s.idle ? 0 : dur,
        idleSec: s.idle ? dur : 0,
        flaggedIdle: s.idle,
        locked: s.locked,
        app: s.app,
        url: s.url,
      });
    });
    this.backfillIdleGrace(slices);

    for (const slice of slices) {
      if (slice.idleSec > 0) {
        idleSec += slice.idleSec;
        hourly[slice.hour].idleSec += slice.idleSec;
      }
      if (slice.activeSec > 0) {
        activeSec += slice.activeSec;
        hourly[slice.hour].activeSec += slice.activeSec;
        // App/site time follows the active portion only, so reclassified seconds
        // stop inflating "top apps" as well.
        if (slice.app) apps.set(slice.app, (apps.get(slice.app) ?? 0) + slice.activeSec);
        if (slice.url) sites.set(slice.url, (sites.get(slice.url) ?? 0) + slice.activeSec);
      }
    }

    const extraSec = Math.max(0, activeSec - workingBasisSec);
    const remainingSec = Math.max(0, workingBasisSec - activeSec);

    return {
      date,
      activeSec,
      idleSec,
      workingBasisSec,
      extraSec,
      remainingSec,
      clockedOut: activeSec >= workingBasisSec,
      clockInAt: samples.length ? samples[0].at.toISOString() : null,
      clockOutAt: endedAt
        ? endedAt.toISOString()
        : samples.length
          ? samples[samples.length - 1].at.toISOString()
          : null,
      topApps: this.top(apps),
      topWebsites: this.top(sites),
      hourly,
    };
  }

  /** The user's own live payload: current status/app + the day's running totals. */
  static toMyUpdate(current: CurrentActivityView, daily: DailyActivityView): MyActivityUpdate {
    return {
      current,
      date: daily.date,
      activeSec: daily.activeSec,
      idleSec: daily.idleSec,
      workingBasisSec: daily.workingBasisSec,
      remainingSec: daily.remainingSec,
      clockedOut: daily.clockedOut,
      topApps: daily.topApps,
    };
  }

  /** A manager's live payload for one report: team-member view + running totals. */
  static toLiveUpdate(
    member: ActivityTeamMember,
    sample: ActivitySampleRecord | null,
    daily: DailyActivityView,
    now: Date,
  ): LiveActivityUpdate {
    return {
      ...this.toTeamMemberView(member, sample, now),
      activeSec: daily.activeSec,
      idleSec: daily.idleSec,
      topApps: daily.topApps,
    };
  }

  /**
   * The agent can only flag a sample idle once input has *already* been missing for
   * {@link IDLE_THRESHOLD_SEC}, so that lead-in was recorded as active even though
   * nobody was there — the classic "walk away for 7 minutes, get credited 5". For
   * each stretch of idle samples, walk back over the preceding active seconds and
   * move up to one threshold's worth into the idle column.
   *
   * Only already-recorded seconds are reclassified, never invented: a gap the agent
   * never sampled (asleep, closed, offline) stays absent from both totals.
   */
  private static backfillIdleGrace(slices: DaySlice[]): void {
    for (let i = 0; i < slices.length; i++) {
      // Only the first sample of each idle stretch carries a lead-in.
      if (!slices[i].flaggedIdle) continue;
      if (i > 0 && slices[i - 1].flaggedIdle) continue;
      // A lock is instantaneous: the user was working right up to it, so there is no
      // lead-in to reclaim and reclassifying would steal genuine work.
      if (slices[i].locked) continue;

      let budget = IDLE_THRESHOLD_SEC;
      for (let j = i - 1; j >= 0 && budget > 0; j--) {
        const prev = slices[j];
        // Stop at the previous idle stretch: the lead-in is the contiguous run of
        // active time immediately before this one, nothing earlier.
        if (prev.flaggedIdle || prev.activeSec <= 0) break;

        const moved = Math.min(prev.activeSec, budget);
        prev.activeSec -= moved;
        prev.idleSec += moved;
        budget -= moved;
      }
    }
  }

  private static top(map: Map<string, number>): UsageEntry[] {
    return [...map.entries()]
      .map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, TOP_N);
  }
}
