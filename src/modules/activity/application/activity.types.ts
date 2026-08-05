import { HourBucket, UsageEntry } from '@shared/types/common.types';
import { TeamMemberView } from '@shared/types/user.types';

export type ActivityStatus = 'ACTIVE' | 'IDLE' | 'OFFLINE';

export interface CurrentActivityView {
  status: ActivityStatus;
  app: string | null;
  title: string | null;
  url: string | null;
  idle: boolean;
  /** ISO timestamp of the last sample, or null if there is none. */
  lastSampleAt: string | null;
  /** Seconds since the last sample (how "live" this is). */
  staleSec: number;
}

export interface TeamMemberActivityView extends TeamMemberView {
  status: ActivityStatus;
  app: string | null;
  title: string | null;
  url: string | null;
  lastSampleAt: string | null;
}

export interface DailyActivityView {
  date: string;
  activeSec: number;
  idleSec: number;
  workingBasisSec: number;
  /** Active time worked beyond the basis (overtime). */
  extraSec: number;
  /** Active time still to work before reaching the basis. */
  remainingSec: number;
  /** True once active time has reached the working basis. */
  clockedOut: boolean;
  clockInAt: string | null;
  clockOutAt: string | null;
  topApps: UsageEntry[];
  topWebsites: UsageEntry[];
  hourly: HourBucket[];
}

/**
 * Real-time payload pushed to a user's own dashboard (`activity:me`) as each
 * sample lands — their live status + current app plus the day's running totals.
 */
export interface MyActivityUpdate {
  current: CurrentActivityView;
  date: string;
  activeSec: number;
  idleSec: number;
  workingBasisSec: number;
  remainingSec: number;
  clockedOut: boolean;
  /** The day's ranked top apps so far (live). */
  topApps: UsageEntry[];
}

/**
 * Real-time payload pushed to a manager's live board (`activity:update`) for one
 * report — the same shape as the team-live view, plus the report's running totals.
 */
export interface LiveActivityUpdate extends TeamMemberActivityView {
  activeSec: number;
  idleSec: number;
  /** The report's ranked top apps so far today (live). */
  topApps: UsageEntry[];
}

export interface ActivityAck {
  ok: true;
  /** Seconds of active (non-idle) work accumulated today. */
  activeSec: number;
  /** The day's working basis (default 9h). */
  workingBasisSec: number;
  /** Active seconds still to work before reaching the basis. */
  remainingSec: number;
  /**
   * True once the working basis is reached. INFORMATIONAL ONLY — this drives the
   * overtime figures (work beyond the basis is optional overtime); it does NOT
   * stop tracking or screenshots. Use `shouldCapture` for that.
   */
  clockedOut: boolean;
  /**
   * True once the user has explicitly ended their day (the "End Day" button).
   */
  dayEnded: boolean;
  /**
   * Whether the agent should keep taking screenshots right now. True for the
   * whole working day — including overtime past the 9h basis and idle stretches
   * — and flips to false only once the day has been ended. (Closing the agent is
   * the other, implicit, stop: no agent running means no captures.)
   */
  shouldCapture: boolean;
}

export interface EndDayResult {
  ok: true;
  /** The local day (YYYY-MM-DD) that was ended. */
  date: string;
  /** When the day was ended (first End Day wins if pressed twice). */
  endedAt: string;
}
