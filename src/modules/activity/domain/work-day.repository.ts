export const WORK_DAY_REPOSITORY = Symbol('WORK_DAY_REPOSITORY');

/** A record that a user ended their working day for a given local date. */
export interface WorkDayEndRecord {
  userId: string;
  /** Local calendar day (YYYY-MM-DD), server timezone. */
  date: string;
  endedAt: Date;
}

/** Outcome of {@link WorkDayRepository.markEnded}. */
export interface MarkEndedResult {
  record: WorkDayEndRecord;
  /** True only for the press that actually ended the day (drives the one-shot event). */
  created: boolean;
}

/**
 * Tracks the explicit "End Day" action. While no end exists for a user's current
 * local day, the agent keeps tracking (overtime + idle included); once ended,
 * activity, screenshots and attendance all stop for the rest of that day.
 */
export interface WorkDayRepository {
  /** The end record for a user on a local day, or null if the day is still open. */
  findEnd(userId: string, date: string): Promise<WorkDayEndRecord | null>;

  /** End records for the given users on a local day, keyed by userId (open days omitted). */
  findEndsForUsers(userIds: string[], date: string): Promise<Map<string, WorkDayEndRecord>>;

  /**
   * Mark the day ended. Idempotent: if already ended, the existing (first)
   * `endedAt` is kept and returned rather than overwritten, and `created` is false.
   */
  markEnded(userId: string, date: string, endedAt: Date): Promise<MarkEndedResult>;

  /**
   * Reverse "End Day" for a local day (the user pressed "Start day" to resume).
   * Returns true if an end mark was actually cleared, false if the day was already
   * open. Idempotent.
   */
  clearEnd(userId: string, date: string): Promise<boolean>;
}
