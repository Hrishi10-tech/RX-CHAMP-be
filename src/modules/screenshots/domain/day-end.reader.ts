export const DAY_END_READER = Symbol('DAY_END_READER');

/**
 * Reads the "End Day" marks the activity module owns, so an upload that arrives
 * after the user signed off can be rejected rather than landing in their day.
 * Kept as its own port so screenshots doesn't depend on the activity module.
 */
export interface DayEndReader {
  /** True once the user has ended their working day for that local date. */
  hasEnded(userId: string, date: string): Promise<boolean>;
}
