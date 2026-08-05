import { TimeInterval } from '@shared/types/common.types';

export const ONLINE_SESSION_REPOSITORY = Symbol('ONLINE_SESSION_REPOSITORY');

export interface OnlineSessionRepository {
  /**
   * Records an active heartbeat. Extends the user's open online session when the
   * gap since the last heartbeat is within the grace window; otherwise closes the
   * stale session (at its last-seen time) and opens a fresh one. Idempotent-ish:
   * safe to call on every heartbeat.
   */
  heartbeat(
    userId: string,
    date: string,
    now: Date,
    graceSec: number,
    deviceId?: string | null,
  ): Promise<void>;

  /** Closes the user's open online session at its last-seen time (idle / logout / shift end). */
  closeOpenForUser(userId: string, now: Date): Promise<void>;

  /** Total online seconds for a user on a local day (open sessions count up to last-seen). */
  sumSecondsForUserByDate(userId: string, date: string, now: Date): Promise<number>;

  /** Online seconds per user for a local day, keyed by userId (missing users = 0). */
  sumSecondsForUsersByDate(
    userIds: string[],
    date: string,
    now: Date,
  ): Promise<Map<string, number>>;

  /** Online seconds for one user across the given days, keyed by date (missing days = 0). */
  sumSecondsForUserByDates(userId: string, dates: string[], now: Date): Promise<Map<string, number>>;

  /** Active online intervals for a user on a local day (open sessions end at last-seen). */
  listIntervalsForUserByDate(userId: string, date: string): Promise<TimeInterval[]>;
}
