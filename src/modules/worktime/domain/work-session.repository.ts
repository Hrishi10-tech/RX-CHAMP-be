import { AgentGeneration } from './agent-generation';

export const WORK_SESSION_REPOSITORY = Symbol('WORK_SESSION_REPOSITORY');

export type WorkSessionEndReason = 'USER' | 'AUTO_CLOSED';
/** REPLAY (4.0): opened by an offline action replayed later (auditable, see agent_events). */
export type WorkSessionSource = 'AGENT' | 'LEGACY' | 'BACKFILL' | 'REPLAY';

export interface WorkSessionRecord {
  id: string;
  userId: string;
  /** Business-timezone day of startedAt. */
  date: string;
  startedAt: Date;
  endedAt: Date | null;
  endReason: WorkSessionEndReason | null;
  source: string;
}

export type DayClosedCode = 'DAY_NOT_STARTED' | 'DAY_ENDED';

export type EnsureOpenResult =
  | { ok: true; session: WorkSessionRecord; implicit: boolean }
  | { ok: false; code: DayClosedCode };

export interface StartDayTxResult {
  /** False when a session was already open (returned as is). */
  opened: boolean;
  /** True when this opened a second (or later) session of the same day. */
  resumed: boolean;
  session: WorkSessionRecord;
}

export type EndDayTxResult =
  /** The open session was closed now. `newlyEnded`: the day's end mark was set by this call. */
  | { kind: 'CLOSED'; session: WorkSessionRecord; date: string; endedAt: Date; newlyEnded: boolean }
  /** Nothing open and the day was already ended (idempotent repeat). */
  | { kind: 'ALREADY_ENDED'; date: string; endedAt: Date }
  /** Legacy caller with nothing open: the day is marked ended as in 3.0. */
  | { kind: 'MARKED'; date: string; endedAt: Date; newlyEnded: boolean }
  /** A 3.1 agent with nothing to end. */
  | { kind: 'NOT_STARTED'; date: string };

export interface AutoCloseTxResult {
  /** False when the session was closed meanwhile (someone pressed End Day). */
  closed: boolean;
  /** The day's end mark was set by this close (publish DayEndedEvent). */
  newlyEnded: boolean;
  /** AUTO_SKIPPED records removed because their break was after the real end. */
  droppedSkips: number;
  /**
   * The session had been auto-closed before (a replayed action reopened it, which
   * keeps endReason AUTO_CLOSED while open): nothing is announced again.
   */
  reclosed?: boolean;
}

export interface LastInputQuery {
  sessionId: string;
  userId: string;
  from: Date;
  to: Date;
}

/**
 * A day ended this recently still counts as the person's day when nothing has
 * started since: the workday view shows it as `lastEnded`, and End Day pressed
 * again (after midnight, or after a night shift) answers with it.
 */
export const LAST_ENDED_WITHIN_MS = 12 * 3_600_000;

/**
 * Work sessions (SPEC 1.1). Every write that can race (Start Day, End Day, the
 * implicit legacy session, auto-close, a skip or meeting needing an open day)
 * runs in one transaction holding the user's row lock; the partial unique index
 * work_sessions_one_open_per_user is the safety net behind it.
 */
export interface WorkSessionRepository {
  findOpen(userId: string): Promise<WorkSessionRecord | null>;
  /** The person's most recently ended session, or null. */
  findLastEnded(userId: string): Promise<WorkSessionRecord | null>;
  /** Every open session (the auto-close job). */
  listOpen(): Promise<WorkSessionRecord[]>;
  listForUserOnDate(userId: string, date: string): Promise<WorkSessionRecord[]>;
  /** Sessions dated fromDate..toDate (inclusive), oldest first. */
  listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<WorkSessionRecord[]>;
  /** Sessions overlapping [from, to] in time (open ones count to now), any date. */
  listOverlapping(userIds: string[], from: Date, to: Date): Promise<WorkSessionRecord[]>;
  /** Users with a session dated on one of `dates` or still open (the auto-skip job). */
  listUserIdsActiveOn(dates: string[]): Promise<string[]>;
  /** The day's End Day mark (work_day_ends.ended_at), or null. */
  dayEndedAt(userId: string, date: string): Promise<Date | null>;

  /**
   * Start Day: an open session is returned as is; otherwise one opens at
   * `startedAt` (never before the end of the person's last session), dated by
   * its business day, and that day's End Day mark is cleared.
   */
  startDay(
    userId: string,
    startedAt: Date,
    now: Date,
    source: WorkSessionSource,
    /** The person's working day of a moment (dates the new session). */
    dayOf: (at: Date) => string,
  ): Promise<StartDayTxResult>;

  /**
   * End Day: closes the open session now (USER), closes any open break, lunch
   * or meeting at the same instant and sets the End Day mark. With nothing open:
   * ALREADY_ENDED when the day is ended, MARKED for a legacy caller (3.0
   * behaviour), ALREADY_ENDED with the day of a session that ended since
   * `endedSince` (a repeat after midnight or after a night shift), else NOT_STARTED.
   */
  endDay(
    userId: string,
    now: Date,
    today: string,
    legacy: boolean,
    endedSince: Date,
  ): Promise<EndDayTxResult>;

  /**
   * The day must be open for an action (a skip, a meeting, a break start). A
   * legacy caller with nothing open and the day not ended gets an implicit
   * LEGACY session at now; a 3.1 agent gets DAY_NOT_STARTED or DAY_ENDED.
   */
  ensureOpen(
    userId: string,
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<EnsureOpenResult>;

  /**
   * The implicit LEGACY session at an older agent's first active sample of the
   * day. Null when one is already open or the day was ended.
   */
  openImplicit(userId: string, at: Date, today: string): Promise<WorkSessionRecord | null>;

  /** PC sign-in times recorded by the agents (work_day_ends.login_at) on these days. */
  loginTimes(userId: string, dates: string[]): Promise<Date[]>;

  /**
   * Closes a stale session at `closeAt` (AUTO_CLOSED), closes open presence
   * sessions at the same instant, drops the day's AUTO_SKIPPED records scheduled
   * after `closeAt` (never owed) and sets the day's End Day mark if unset.
   */
  autoClose(session: WorkSessionRecord, closeAt: Date): Promise<AutoCloseTxResult>;

  /** The last non-idle activity sample `at` inside each window, keyed by sessionId. */
  lastInputs(queries: LastInputQuery[]): Promise<Map<string, Date | null>>;

  /** The person's latest work session that started at or before `at`. */
  lastStartedAtOrBefore(userId: string, at: Date): Promise<WorkSessionRecord | null>;

  /**
   * Moves an AUTO_CLOSED session's end later, to `to` (an input that arrived late),
   * with the day's End Day mark when that mark was the old end, and makes it a
   * REPLAY session (it now rests on late evidence). False when the session changed
   * meanwhile.
   */
  extendAutoClosed(session: WorkSessionRecord, to: Date): Promise<boolean>;
}
