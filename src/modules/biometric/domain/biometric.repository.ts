import { PlannedSession, PunchDirection, PunchSource } from './punch';

export const BIOMETRIC_REPOSITORY = Symbol('BIOMETRIC_REPOSITORY');

export interface PunchRecord {
  id: string;
  /** 4.0: the organisation whose key, pull or admin sent it; codes match its people only. */
  companyId: string;
  code: string;
  codeKey: string;
  punchedAt: Date;
  direction: PunchDirection | null;
  deviceId: string;
  externalId: string | null;
  source: PunchSource;
  userId: string | null;
  dayKey: string;
  note: string | null;
  createdById: string | null;
  keyId: string | null;
  lockedOut: boolean;
  voidedAt: Date | null;
  voidedById: string | null;
  voidReason: string | null;
  receivedAt: Date;
}

export type NewPunch = Omit<
  PunchRecord,
  'id' | 'voidedAt' | 'voidedById' | 'voidReason' | 'receivedAt'
>;

export interface PunchFilter {
  companyId: string;
  from?: Date;
  to?: Date;
  userId?: string;
  codeKey?: string;
  deviceId?: string;
  unmatchedOnly?: boolean;
  includeVoided?: boolean;
  limit?: number;
}

export interface BiometricPerson {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  department: string | null;
  companyId: string | null;
  companyName: string | null;
  managerId: string | null;
  attendanceSource: 'AGENT' | 'BIOMETRIC';
  biometricCode: string | null;
  attendanceSourceFrom: string | null;
}

export interface AttendanceWrite {
  userId: string;
  attendanceSource: 'AGENT' | 'BIOMETRIC';
  biometricCode: string | null;
  attendanceSourceFrom: string | null;
  /** 3.6: moved back to the agent: the stretch on biometric this ends, kept for the pause. */
  endedBiometric?: { fromDate: string | null; toDate: string };
}

export interface KeyRecord {
  id: string;
  /** 4.0: the organisation the key sends punches for. */
  companyId: string;
  name: string;
  prefix: string;
  createdById: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  revokedAt: Date | null;
}

export interface UnmatchedCode {
  codeKey: string;
  code: string;
  punches: number;
  firstAt: Date;
  lastAt: Date;
  devices: string[];
}

export interface DeviceSeen {
  deviceId: string;
  punches: number;
  punchesToday: number;
  lastPunchAt: Date;
  lastReceivedAt: Date;
}

/** What replacing a biometric day did. */
export interface ReplaceDayResult {
  /** The day had sessions before and has them now, or a change in open state. */
  changed: boolean;
  /** Open before, and now. */
  wasOpen: boolean;
  open: boolean;
  /** The day had no biometric session before. */
  wasEmpty: boolean;
  /** Set when this made the day end (publish DayEndedEvent). */
  newlyEnded: boolean;
  /** A work-from-home session on the phone was ended at a punch at the office. */
  closedWfhAt: Date | null;
}

/** A stretch of days the integration was on (3.6), with who switched it. */
export interface IntegrationPeriodRecord {
  id: string;
  fromDate: string;
  toDate: string | null;
  startedAt: Date;
  endedAt: Date | null;
  startedByName: string | null;
  endedByName: string | null;
}

export interface BiometricRepository {
  // ---- The integration switch (3.6) ---------------------------------------------
  /** 4.0: the organisation's periods (each runs its own integration), newest first. */
  integrationPeriods(companyId: string): Promise<IntegrationPeriodRecord[]>;
  /**
   * Opens a period of the organisation from `date`, or closes its open one at `date`.
   * False when nothing changed. Another organisation's periods are never touched.
   */
  switchIntegration(
    companyId: string,
    on: boolean,
    date: string,
    at: Date,
    byId: string,
  ): Promise<boolean>;

  // ---- Punches ----------------------------------------------------------------
  /** Stores new punches; one already stored (same code, time and device) is skipped. */
  insertPunches(rows: NewPunch[]): Promise<{ inserted: PunchRecord[]; duplicates: number }>;
  findPunch(id: string): Promise<PunchRecord | null>;
  voidPunch(id: string, byId: string, reason: string, at: Date): Promise<PunchRecord>;
  listPunches(f: PunchFilter): Promise<{ items: PunchRecord[]; total: number }>;
  /** A person's punches (voided ones too) on these working days, oldest first. */
  punchesOfDays(userId: string, dayKeys: string[]): Promise<PunchRecord[]>;
  /** Every punch of the organisation with these codes (matching again after a code changes). */
  punchesWithCodes(companyId: string, codeKeys: string[]): Promise<PunchRecord[]>;
  setPunchOwner(
    rows: { id: string; userId: string | null; dayKey: string; lockedOut: boolean }[],
  ): Promise<void>;
  unmatchedCodes(companyId: string, limit: number): Promise<UnmatchedCode[]>;
  devices(companyId: string, todayFrom: Date): Promise<DeviceSeen[]>;
  stats(
    companyId: string,
    todayFrom: Date,
  ): Promise<{
    lastPunchAt: Date | null;
    lastReceivedAt: Date | null;
    punchesToday: number;
    unmatched: number;
  }>;

  // ---- People -----------------------------------------------------------------
  /** Active people of the organisation (4.0: never anyone else's). */
  people(filter: {
    search?: string;
    companyId: string;
    source?: 'AGENT' | 'BIOMETRIC';
    ids?: string[];
  }): Promise<BiometricPerson[]>;
  /** Names of anyone (the punch log: who added or voided a punch), active or not. */
  names(ids: string[]): Promise<Map<string, { firstName: string; lastName: string }>>;
  /** The organisation's people holding these codes (a code is unique within one). */
  peopleByCodes(companyId: string, codeKeys: string[]): Promise<Map<string, BiometricPerson>>;
  /** Saves who checks in how, and any stretch on biometric this ends, in one transaction. */
  setAttendance(rows: AttendanceWrite[], at: Date, byId: string): Promise<void>;
  /** The last valid punch of each of these people. */
  lastPunchOf(userIds: string[]): Promise<Map<string, Date>>;

  // ---- Integration keys --------------------------------------------------------
  createKey(data: {
    companyId: string;
    name: string;
    prefix: string;
    hash: string;
    createdById: string;
  }): Promise<KeyRecord>;
  listKeys(companyId: string): Promise<KeyRecord[]>;
  findKeyByHash(hash: string): Promise<KeyRecord | null>;
  touchKey(id: string, at: Date, ip: string | null): Promise<void>;
  revokeKey(companyId: string, id: string, byId: string, at: Date): Promise<boolean>;

  // ---- Days -------------------------------------------------------------------
  /**
   * Makes the person's BIOMETRIC sessions of `dayKey` the planned ones (under the
   * person's row lock): an open biometric day of an earlier date closes at its last
   * punch, and a work-from-home session on the phone running at the first punch
   * after its start ends there. The first session keeps its late-start reason.
   */
  replaceDay(
    userId: string,
    dayKey: string,
    planned: PlannedSession[],
    lastPunchAt: Date | null,
  ): Promise<ReplaceDayResult>;
  /** Open BIOMETRIC sessions (the close job). */
  openDays(): Promise<{ userId: string; date: string; startedAt: Date }[]>;
  /** Which of these months (YYYY-MM) the organisation has locked for payroll (4.0: per organisation). */
  lockedMonths(companyId: string, months: string[]): Promise<Set<string>>;
  /** Organisations still in use (the pull job reads each one's settings). */
  companyIds(): Promise<string[]>;
}
