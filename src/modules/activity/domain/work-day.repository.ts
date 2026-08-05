export const WORK_DAY_REPOSITORY = Symbol('WORK_DAY_REPOSITORY');

/** A record that a user ended their working day for a given local date. */
export interface WorkDayEndRecord {
  userId: string;
  /** Local calendar day (YYYY-MM-DD), server timezone. */
  date: string;
  endedAt: Date;
}

/**
 * Tracks the explicit "End Day" action. While no end exists for a user's current
 * local day, the agent keeps capturing (overtime + idle included); once ended,
 * capture stops for the rest of that day.
 */
export interface WorkDayRepository {
  /** The end record for a user on a local day, or null if the day is still open. */
  findEnd(userId: string, date: string): Promise<WorkDayEndRecord | null>;

  /**
   * Mark the day ended. Idempotent: if already ended, the existing (first)
   * `endedAt` is kept and returned rather than overwritten.
   */
  markEnded(userId: string, date: string, endedAt: Date): Promise<WorkDayEndRecord>;
}
