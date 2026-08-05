export const PRESENCE_SESSION_REPOSITORY = Symbol('PRESENCE_SESSION_REPOSITORY');

/** The non-working statuses an employee can be in. "Working" is the absence of an open session. */
export type PresenceKind = 'BREAK' | 'LUNCH' | 'MEETING';

export interface PresenceSessionRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  type: PresenceKind;
  note: string | null;
  date: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number | null;
}

export interface OpenSessionData {
  userId: string;
  type: PresenceKind;
  note?: string | null;
  date: string;
  deviceId?: string | null;
}

export interface PresenceSessionRepository {
  /** The user's current open (live) session, or null if they're working. */
  findOpenForUser(userId: string): Promise<PresenceSessionRecord | null>;

  /**
   * Atomically closes any open session for the user, then opens a new one.
   * Returns both so callers can report what changed. Closing stamps `endedAt`
   * and computes `durationSec`.
   */
  switchTo(
    data: OpenSessionData,
    now: Date,
  ): Promise<{ closed: PresenceSessionRecord | null; opened: PresenceSessionRecord }>;

  /** Closes the user's open session (→ back to working). Returns it, or null if none was open. */
  endOpenForUser(userId: string, now: Date): Promise<PresenceSessionRecord | null>;

  /** All of a user's sessions for a given local day, newest first. */
  listForUserByDate(userId: string, date: string): Promise<PresenceSessionRecord[]>;

  /** The current open session for each of the given users (users who are working are omitted). */
  listOpenForUsers(userIds: string[]): Promise<PresenceSessionRecord[]>;

  /** All sessions for the given users on a local day. */
  listForUsersByDate(userIds: string[], date: string): Promise<PresenceSessionRecord[]>;

  /** All of a user's sessions across the given local days. */
  listForUserInDates(userId: string, dates: string[]): Promise<PresenceSessionRecord[]>;
}
