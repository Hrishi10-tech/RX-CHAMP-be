export const WORKED_DAYS_READER = Symbol('WORKED_DAYS_READER');

/**
 * Who has worked (started) a given working day. A day off only shows its break
 * schedule once the person has started it (3.2: a day off can be worked, with the
 * shift's usual rules).
 */
export interface WorkedDaysReader {
  /** The people among `userIds` with a work session dated `date`. */
  usersWithSessionOn(userIds: string[], date: string): Promise<Set<string>>;
}
