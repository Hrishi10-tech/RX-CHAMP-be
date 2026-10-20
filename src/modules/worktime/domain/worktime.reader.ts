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

/**
 * 4.0: a stretch of a work session covered by the agent's activity samples (each
 * sample covers [at, at + min(duration, MAX_GAP_SEC)]; idle and locked ones too),
 * neighbours less than COVERAGE_JOIN_SEC apart already joined.
 */
export interface CoverageRow {
  userId: string;
  sessionId: string;
  startedAt: Date;
  endedAt: Date;
}

/** A (person, working day) with work sessions, and whether it can still change. */
export interface SessionDayRow {
  userId: string;
  date: string;
  /** Every session of the day closed before the cut-off (nothing can change it now). */
  settled: boolean;
  /** Every session of the day has ended (a late sample or a replay may still change it). */
  closed?: boolean;
  /** The day's sessions as they stand (how many, last change): unchanged, unchanged day. */
  stamp?: string;
}

export interface PersonRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'USER';
  department: string | null;
  designation: string | null;
  companyId: string | null;
  /** 4.0: the person's department. */
  departmentId: string | null;
  /** 3.x reporting line (display only since 4.0). */
  managerId: string | null;
  managerName: string | null;
  /** status ACTIVE and not deleted. */
  active: boolean;
  /** Business day the account was created: earlier days are not counted against them. */
  joinedOn: string;
}

export interface PeopleFilter {
  /** Direct reports of this person (any status). 3.x; not used for access since 4.0. */
  managerId?: string;
  ids?: string[];
  /** 4.0: only this organisation's people. */
  companyId?: string;
  /** 4.0: only people in these departments. */
  departmentIds?: string[];
  /** 4.0: only these roles. */
  roles?: PersonRow['role'][];
  /** 4.0: never these roles (organisation lists leave Super Admins out). */
  excludeRoles?: PersonRow['role'][];
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
  /**
   * 4.0: what of these work sessions (the REPLAY ones) the agent's activity samples
   * cover, as joined stretches, in one aggregated query.
   */
  activityCoverage(sessionIds: string[]): Promise<CoverageRow[]>;
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
  /** 4.0: the departments each of these managers is assigned to (not deleted). */
  managedDepartments(managerIds: string[]): Promise<Map<string, string[]>>;
  /** 4.0: every organisation that is not deleted. */
  listCompanyIds(): Promise<string[]>;
  /** 4.0: departments of an organisation (not deleted). */
  departmentsOf(companyId: string): Promise<DepartmentRow[]>;
  /** 4.0: live facts per person: last activity sample, device seen, agent version, agent activation. */
  liveFacts(userIds: string[]): Promise<Map<string, LiveFacts>>;
  /** 4.0: active Admins of an organisation. */
  orgAdminCount(companyId: string): Promise<number>;
  /** 4.0: an organisation's name. */
  companyName(companyId: string): Promise<string | null>;
}

export interface DepartmentRow {
  id: string;
  name: string;
  icon: string;
}

export interface LiveFacts {
  lastSampleAt: Date | null;
  lastSampleIdle: boolean;
  lastSeenAt: Date | null;
  agentVersion: string | null;
  agentActivatedAt: Date | null;
}
