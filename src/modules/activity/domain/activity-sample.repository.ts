export const ACTIVITY_SAMPLE_REPOSITORY = Symbol('ACTIVITY_SAMPLE_REPOSITORY');

/** A foreground-activity sample as stored. */
export interface ActivitySampleRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  date: string;
  at: Date;
  durationSec: number;
  idle: boolean;
  /** Workstation was locked — inactivity that began at this sample, not before it. */
  locked: boolean;
  app: string | null;
  title: string | null;
  url: string | null;
}

/** A new sample the agent is reporting (duration is filled in later). */
export interface NewActivitySample {
  userId: string;
  deviceId?: string | null;
  date: string;
  at: Date;
  idle: boolean;
  locked?: boolean;
  app?: string | null;
  title?: string | null;
  url?: string | null;
}

/**
 * Stores per-minute foreground samples. The newest sample of a user is left
 * "open" (durationSec = 0); when the next sample arrives we stamp the previous
 * one with how long its app actually stayed in the foreground.
 */
export interface ActivitySampleRepository {
  /** The user's most recent sample (any day), or null. */
  findLatestForUser(userId: string): Promise<ActivitySampleRecord | null>;

  /** The most recent sample for each of the given users (for a team live board). */
  findLatestForUsers(userIds: string[]): Promise<Map<string, ActivitySampleRecord>>;

  /** Every sample for a user on a local day, ordered by `at` ascending. */
  listForUserByDate(userId: string, date: string): Promise<ActivitySampleRecord[]>;

  /** Fill in a sample's foreground duration (called when the next sample lands). */
  stampDuration(id: string, durationSec: number): Promise<void>;

  /** Insert a new (open) sample. */
  create(sample: NewActivitySample): Promise<ActivitySampleRecord>;
}
