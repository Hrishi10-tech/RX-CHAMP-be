/**
 * What the replay interceptor needs to know about a working day before it reopens
 * an auto-closed one (re-audit M2). Implemented by the worktime module
 * (WorkSessionsService) and looked up at run time, so the shared interceptor does
 * not depend on it.
 */
export const REPLAY_DAY_LIMITS = Symbol('REPLAY_DAY_LIMITS');

export interface ReplayDaySession {
  userId: string;
  date: string;
  startedAt: Date;
}

export interface ReplayDayLimits {
  /**
   * The latest end of this session's working day: its shift end plus the
   * auto-close allowance (start + 14 h with no shift), the same limit a late input
   * may move an automatic close to.
   */
  latestEndOfSession(session: ReplayDaySession): Promise<Date>;
}
