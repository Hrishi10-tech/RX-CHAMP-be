import { TimeInterval } from '@shared/types/common.types';

export const IDLE_READER = Symbol('IDLE_READER');

/**
 * Read-only view over idle time, sourced from the activity module's per-minute
 * `ActivitySample` rows (samples flagged `idle` = no mouse/keyboard input past
 * the agent's idle threshold, e.g. 5 min). Presence has no idle concept of its
 * own — the online-session stream drops idle time — so we surface it here for
 * the manager timeline/history views.
 */
export interface IdleReader {
  /** Idle intervals for a user on a local day (each sample → [at, at+duration]). */
  listIdleIntervalsForUserByDate(userId: string, date: string): Promise<TimeInterval[]>;

  /** Total idle seconds for one user across the given days, keyed by date (missing days = 0). */
  sumIdleSecondsForUserByDates(userId: string, dates: string[]): Promise<Map<string, number>>;
}
