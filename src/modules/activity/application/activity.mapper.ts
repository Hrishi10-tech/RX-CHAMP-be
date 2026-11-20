import { HourBucket, UsageEntry } from '@shared/types/common.types';
import { fullName } from '@shared/types/user.types';
import { ActivitySampleRecord } from '../domain/activity-sample.repository';
import { ActivityTeamMember } from '../domain/activity-access.reader';
import { MeetingWindow } from '../domain/meeting-window.reader';
import { appDisplayName } from './app-display-name';
import { clamp, elapsedSeconds, localDateString } from './activity-date.util';
import { appTimezone } from '@shared/utils/timezone';
import { hourWindows } from '@modules/worktime/domain/hourly';
import { InputSample, inputIntervals, overlapIn } from '@modules/worktime/domain/input-activity';
import { intersect, normalize, subtract } from '@modules/worktime/domain/intervals';
import { LIVE_GRACE_SEC, MAX_GAP_SEC, TOP_N } from './activity.constants';
import { isLockedSample } from './locked-time.util';
import {
  ActivityStatus,
  CurrentActivityView,
  DailyActivityView,
  LiveActivityUpdate,
  MyActivityUpdate,
  TeamMemberActivityView,
} from './activity.types';

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
    return sample.idle || isLockedSample(sample) ? 'IDLE' : 'ACTIVE';
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
      idle: sample.idle || isLockedSample(sample),
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
    const tz = appTimezone();
    // One rule set for every screen (input-activity.ts, Fix 10): each PC read on its
    // own, the idle lead-in before an idle flag is idle, a lock is idle from the
    // instant it locks, a locked sleeping PC's hole is idle, input on any PC wins.
    const input: InputSample[] = samples.map((s) => ({
      at: s.at,
      durationSec: s.durationSec,
      idle: s.idle,
      locked: s.locked,
      app: s.app,
      deviceId: s.deviceId ?? null,
    }));
    // A trailing open sample of a past day has an unknown tail: it stands for nothing.
    const openUntil = dayIsToday ? asOf : new Date(Math.min(asOf.getTime(), this.lastAt(samples)));
    const intervals = inputIntervals(input, openUntil);
    // A meeting outranks the idle flag: the user is working, just not typing.
    const meetingSpans = normalize(
      meetings
        .map((m) => {
          const start = m.start.getTime();
          if (m.end) return { start, end: m.end.getTime() };
          // An unclosed meeting is only trusted while it could still be running
          // (today, up to now); left open on a past day it is incomplete data.
          return { start, end: dayIsToday ? asOf.getTime() : start };
        })
        .filter((m) => m.end > m.start),
    );
    const active = normalize([...intervals.active, ...intersect(intervals.idle, meetingSpans)]);
    const idle = subtract(intervals.idle, meetingSpans);

    const hourly: HourBucket[] = hourWindows(date, tz).map((w, hour) => ({
      hour,
      activeSec: Math.round(overlapIn(active, [w]) / 1000),
      idleSec: Math.round(overlapIn(idle, [w]) / 1000),
    }));
    const activeSec = hourly.reduce((sum, h) => sum + h.activeSec, 0);
    const idleSec = hourly.reduce((sum, h) => sum + h.idleSec, 0);

    // App and site time follows each sample's active part only, so the idle lead-in
    // stops inflating "top apps" as well.
    const apps = new Map<string, number>();
    const sites = new Map<string, number>();
    samples.forEach((s, i) => {
      const dur = this.durationOf(s, i === samples.length - 1, dayIsToday, asOf);
      if (dur <= 0) return;
      const start = s.at.getTime();
      const sec = Math.round(overlapIn(active, [{ start, end: start + dur * 1000 }]) / 1000);
      if (sec <= 0) return;
      // Renamed before aggregating, so a stored `TimeChampAgent` and a newer
      // `RX Vision Agent` land in the same row rather than two.
      const app = appDisplayName(s.app);
      if (app) apps.set(app, (apps.get(app) ?? 0) + sec);
      if (s.url) sites.set(s.url, (sites.get(s.url) ?? 0) + sec);
    });

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

  /** The newest sample's instant (ms), or 0 with none. */
  private static lastAt(samples: ActivitySampleRecord[]): number {
    return samples.reduce((max, x) => Math.max(max, x.at.getTime()), 0);
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

  private static top(map: Map<string, number>): UsageEntry[] {
    return [...map.entries()]
      .map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, TOP_N);
  }
}
