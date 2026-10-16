export const WORKTIME_READER = Symbol('WORKTIME_READER');

export interface PresenceRow {
  id: string;
  userId: string;
  type: 'BREAK' | 'LUNCH' | 'MEETING';
  note: string | null;
  date: string;
  startedAt: Date;
  endedAt: Date | null;
}

export interface HourBucketRow {
  userId: string;
  date: string;
  hour: number;
  activeSec: number;
}

/** A (person, working day) with work sessions, and whether it can still change. */
export interface SessionDayRow {
  userId: string;
  date: string;
  /** Every session of the day closed before the cut-off (nothing can change it now). */
  settled: boolean;
}

export interface PersonRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'SUPER_ADMIN' | 'MANAGER' | 'USER';
  department: string | null;
  designation: string | null;
  companyId: string | null;
  managerId: string | null;
  managerName: string | null;
  /** status ACTIVE and not deleted. */
  active: boolean;
  /** Business day the account was created: earlier days are not counted against them. */
  joinedOn: string;
}

export interface PeopleFilter {
  /** Direct reports of this person (any status). */
  managerId?: string;
  ids?: string[];
}

/**
 * Batch reads for the working-day views and reports: one query per table per
 * request, never one per person.
 */
export interface WorktimeReader {
  /** Presence sessions of these people overlapping [from, to] (open ones count to now). */
  presenceOverlapping(userIds: string[], from: Date, to: Date): Promise<PresenceRow[]>;
  /** The (person, working day) pairs with work sessions dated in the range. */
  sessionDays(
    userIds: string[],
    fromDate: string,
    toDate: string,
    settledBefore: Date,
  ): Promise<SessionDayRow[]>;
  /**
   * Active seconds per (person, working day, local hour) of these days, aggregated
   * in SQL from the samples inside each work session of the day.
   */
  activeSecByHour(days: { userId: string; date: string }[], tz: string): Promise<HourBucketRow[]>;
  /** People, with their manager's name; any status unless filtered by the caller. */
  listPeople(filter: PeopleFilter): Promise<PersonRow[]>;
  /** Which of these people (or anyone, when null) have a work session dated in the range. */
  userIdsWithSessionsBetween(
    userIds: string[] | null,
    fromDate: string,
    toDate: string,
  ): Promise<Set<string>>;
  /** Active people in a company matching a name, for the meeting participants picker. */
  searchParticipants(
    companyId: string | null,
    q: string,
    excludeId: string,
    limit: number,
  ): Promise<{ id: string; firstName: string; lastName: string; department: string | null }[]>;
  /** Which of these ids are active people in the company. */
  knownPeopleIds(companyId: string | null, ids: string[]): Promise<Set<string>>;
  /** The earliest work session day, or null. */
  earliestSessionDate(): Promise<string | null>;
}
