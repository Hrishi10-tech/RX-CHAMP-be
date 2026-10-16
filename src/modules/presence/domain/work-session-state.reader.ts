export const WORK_SESSION_STATE_READER = Symbol('WORK_SESSION_STATE_READER');

export interface WorkSessionState {
  /** A work session is open now (any date). */
  open: boolean;
  /** A work session is dated on the person's working day `today`. */
  startedToday: boolean;
  /** The person's working day now: their shift-day (night shifts), else the calendar day. */
  today: string;
}

/**
 * Reads the 3.1 work sessions the worktime module owns, so presence can say
 * NOT_STARTED (no open session and none on the working day) without depending on it.
 */
export interface WorkSessionStateReader {
  statesFor(userIds: string[], now: Date): Promise<Map<string, WorkSessionState>>;
}

/** True when the person has not started today (and nothing is open). */
export function notStarted(state: WorkSessionState | undefined): boolean {
  return !state || (!state.open && !state.startedToday);
}
