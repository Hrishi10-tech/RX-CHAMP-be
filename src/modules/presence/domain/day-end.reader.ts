export const DAY_END_READER = Symbol('DAY_END_READER');

/** When a user ended their working day, for one local calendar day. */
export interface DayEnd {
  userId: string;
  endedAt: Date;
}

/**
 * Reads the "End Day" marks the activity module owns. Presence needs them for two
 * reasons: attendance must stop accruing at the same instant activity does, and a
 * report who has signed off shows as DAY_ENDED on the manager's board rather than
 * WORKING. Kept as its own port so presence doesn't depend on the activity module
 * (mirrors how activity reads meeting windows through MEETING_WINDOW_READER).
 */
export interface DayEndReader {
  /** The user's end mark for a local day, or null while the day is still open. */
  findEnd(userId: string, date: string): Promise<DayEnd | null>;

  /** End marks for the given users on a local day, keyed by userId (open days omitted). */
  findEndsForUsers(userIds: string[], date: string): Promise<Map<string, DayEnd>>;
}
