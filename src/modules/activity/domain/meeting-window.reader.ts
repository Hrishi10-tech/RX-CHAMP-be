export const MEETING_WINDOW_READER = Symbol('MEETING_WINDOW_READER');

/** A stretch of a day the user spent in a meeting. `end` is null while it is running. */
export interface MeetingWindow {
  start: Date;
  end: Date | null;
}

/**
 * A day's meeting periods. A meeting is working time even though nobody touches the
 * keyboard, so the daily rollup credits it as active rather than idle — this port lets
 * the activity module read those periods without depending on the presence module.
 */
export interface MeetingWindowReader {
  listForUserByDate(userId: string, date: string): Promise<MeetingWindow[]>;
}
