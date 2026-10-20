/**
 * "The day must be open for this action" (the worktime module's rule, SPEC 3.1),
 * for modules that worktime itself depends on (presence): a 3.1+ agent gets 409
 * DAY_NOT_STARTED / DAY_ENDED, an older caller an implicit session. Provided by
 * WorkSessionsService and looked up at run time.
 */
export const WORKDAY_GATE = Symbol('WORKDAY_GATE');

export interface WorkdayGate {
  /** The open session (its working day `date`), or the 409 for a closed day. */
  ensureOpen(
    userId: string,
    generation: 'AGENT_31' | 'LEGACY',
    now: Date,
  ): Promise<{ date: string; startedAt: Date }>;
}
