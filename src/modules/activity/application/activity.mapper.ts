import { HourBucket, UsageEntry } from '@shared/types/common.types';
import { fullName } from '@shared/types/user.types';
import { ActivitySampleRecord } from '../domain/activity-sample.repository';
import { ActivityTeamMember } from '../domain/activity-access.reader';
import { MeetingWindow } from '../domain/meeting-window.reader';
import { appDisplayName } from './app-display-name';
import { clamp, elapsedSeconds, localDateString } from './activity-date.util';
import { IDLE_THRESHOLD_SEC, LIVE_GRACE_SEC, MAX_GAP_SEC, TOP_N } from './activity.constants';
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
  /** Fell inside a meeting, so its active seconds must not be reclassified as idle. */
  inMeeting: boolean;
  app: string | null;
  url: string | null;
}

export class ActivityMapper {
  /**
   * The instant a day's live figures are measured against. Normally "now", but
   * once the user has ended their day everything freezes at `endedAt` — no total
   * may keep growing past the minute they pressed End Day.
   */
  static asOf(now: Date, endedAt: Date | null): Date {
    return endedAt && endedAt < now ? endedAt : now;
  }

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
    // `now` is already clamped to the End Day instant by {@link asOf}, so an
    // ended day's tail stops growing there.
    if (isLatest && dayIsToday) return clamp(elapsedSeconds(sample.at, now), 0, MAX_GAP_SEC);
    return 0;
  }

  /**
   * Live status for a user. An ended day outranks everything: the board shows
   * DAY_ENDED rather than decaying to OFFLINE, so a manager can tell "signed off
   * for the day" apart from "agent stopped reporting".
   */
  static statusOf(
    sample: ActivitySampleRecord | null,
    now: Date,
    dayEnded = false,
  ): ActivityStatus {
    if (dayEnded) return 'DAY_ENDED';
    if (!sample) return 'OFFLINE';
    if (elapsedSeconds(sample.at, now) > LIVE_GRACE_SEC) return 'OFFLINE';
    return sample.idle ? 'IDLE' : 'ACTIVE';
  }

  static toCurrentView(
    sample: ActivitySampleRecord | null,
    now: Date,
    dayEnded = false,
  ): CurrentActivityView {
    const status = this.statusOf(sample, now, dayEnded);
    // Nothing is in the foreground once the day is over, same as being offline.
    if (!sample || status === 'OFFLINE' || status === 'DAY_ENDED') {
      return {
        status,
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
      app: appDisplayName(sample.app),
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
    dayEnded = false,
    loginAt: Date | null = null,
  ): TeamMemberActivityView {
    const status = this.statusOf(sample, now, dayEnded);
    const live = sample && status !== 'OFFLINE' && status !== 'DAY_ENDED';
    return {
      userId: member.id,
      name: fullName(member),
      email: member.email,
      department: member.department,
      status,
      app: live ? appDisplayName(sample!.app) : null,
      title: live ? sample!.title : null,
      url: live ? sample!.url : null,
      lastSampleAt: sample ? sample.at.toISOString() : null,
      loginAt: loginAt ? loginAt.toISOString() : null,
    };
  }

  /**
   * Rolls a day's samples up into totals, top apps/websites, an hourly split and
   * clock in/out. `samples` must be ordered by `at` ascending. When `endedAt` is
   * given (the user pressed "End Day"), it is used as the clock-out time instead
   * of the last sample's timestamp.
   *
   * `meetings` are the day's meeting periods. Sitting in a meeting is working time
   * even though the keyboard is untouched, so samples inside one count as active
   * instead of idle. Breaks and lunches are deliberately not passed here — those are
   * time away from work and stay idle.
   */
  static computeDaily(
    samples: ActivitySampleRecord[],
    date: string,
    workingBasisSec: number,
    now: Date,
    endedAt: Date | null = null,
    meetings: MeetingWindow[] = [],
    loginAt: Date | null = null,
  ): DailyActivityView {
    const dayIsToday = date === localDateString(now);
    // Once the day has been ended, every live figure is measured against that
    // instant instead of the wall clock — the totals must not drift afterwards.
    const asOf = this.asOf(now, endedAt);
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
      const dur = this.durationOf(s, i === samples.length - 1, dayIsToday, asOf);
      if (dur <= 0) return;
      // A meeting outranks the idle flag: the user is working, just not typing.
      const inMeeting = this.isInMeeting(s.at, meetings, dayIsToday, asOf);
      const countIdle = s.idle && !inMeeting;
      slices.push({
        hour: s.at.getHours(),
        activeSec: countIdle ? 0 : dur,
        idleSec: countIdle ? dur : 0,
        flaggedIdle: countIdle,
        locked: s.locked,
        inMeeting,
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
        // Renamed before aggregating, so a stored `TimeChampAgent` and a newer
        // `RX Vision Agent` land in the same row rather than two.
        const app = appDisplayName(slice.app);
        if (app) apps.set(app, (apps.get(app) ?? 0) + slice.activeSec);
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
      dayEnded: endedAt !== null,
      loginAt: loginAt ? loginAt.toISOString() : null,
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
      dayEnded: current.status === 'DAY_ENDED',
      topApps: daily.topApps,
    };
  }

  /** A manager's live payload for one report: team-member view + running totals. */
  static toLiveUpdate(
    member: ActivityTeamMember,
    sample: ActivitySampleRecord | null,
    daily: DailyActivityView,
    now: Date,
    dayEnded = false,
    loginAt: Date | null = null,
  ): LiveActivityUpdate {
    return {
      ...this.toTeamMemberView(member, sample, now, dayEnded, loginAt),
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
  /**
   * Whether a sample landed inside one of the day's meetings. A session covers
   * `[start, end)`, so a sample stamped exactly at `end` belongs to whatever followed.
   *
   * An unclosed session is only trusted while it could still be running — i.e. on today,
   * bounded by `now`. Left-open sessions on a past day are incomplete data (the agent
   * died, or the user never pressed end) and are ignored: honouring them would convert
   * the entire remainder of that day into meeting time.
   */
  private static isInMeeting(
    at: Date,
    meetings: MeetingWindow[],
    dayIsToday: boolean,
    now: Date,
  ): boolean {
    const t = at.getTime();
    return meetings.some((m) => {
      if (t < m.start.getTime()) return false;
      if (m.end) return t < m.end.getTime();
      return dayIsToday && t <= now.getTime();
    });
  }

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
        // active time immediately before this one, nothing earlier. Meeting time is
        // confirmed work, so it is never eligible to be reclassified either.
        if (prev.flaggedIdle || prev.inMeeting || prev.activeSec <= 0) break;

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
