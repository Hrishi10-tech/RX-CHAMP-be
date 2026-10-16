import {
  ApproverRole,
  BreakApprovalStatus,
  BreakKind,
  BreakOutcome,
  BreakPresenceType,
  BreakTiming,
} from './shift.types';

export const BREAK_RECORD_REPOSITORY = Symbol('BREAK_RECORD_REPOSITORY');

/** A break record joined with its presence session (the source of end time). */
export interface BreakRecordRow {
  id: string;
  userId: string;
  date: string;
  kind: BreakKind | null;
  seq: number;
  presenceType: BreakPresenceType;
  shiftId: string | null;
  shiftName: string | null;
  scheduledStart: Date | null;
  durationMin: number | null;
  windowOpen: Date | null;
  windowClose: Date | null;
  ringStart: Date | null;
  ringEnd: Date | null;
  presenceSessionId: string | null;
  startedAt: Date;
  /** From the presence session; null while the break is still running. */
  endedAt: Date | null;
  timing: BreakTiming;
  minutesOff: number;
  reason: string | null;
  overrunReason: string | null;
  source: string;
  approvalStatus: BreakApprovalStatus;
  approverRole: ApproverRole | null;
  approverId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
  // ---- 3.1. Always set by the Prisma adapter; optional so rows built by hand
  //      (tests, 3.0 call sites) read as a taken break with no SLA.
  outcome?: BreakOutcome;
  overrunSec?: number | null;
  overrunAsked?: boolean;
  commentedAt?: Date | null;
  dueAt?: Date | null;
  escalatedAt?: Date | null;
  remindedAt?: Date | null;
}

export function outcomeOf(r: Pick<BreakRecordRow, 'outcome'>): BreakOutcome {
  return r.outcome ?? 'TAKEN';
}

export function isSkipRecord(r: Pick<BreakRecordRow, 'outcome'>): boolean {
  const o = outcomeOf(r);
  return o === 'SKIPPED' || o === 'AUTO_SKIPPED';
}

/**
 * An AUTO_SKIPPED record End Day made inside the break's still-open window (no
 * comment yet): while the window is open the real break may replace it, because
 * the day carried on (End Day was refused by a gate, or the dialog cancelled).
 */
export function isReplaceableAutoSkip(
  r: { outcome: string; reason: string | null; startedAt: Date; windowClose: Date | null },
  now: Date,
): boolean {
  return (
    r.outcome === 'AUTO_SKIPPED' &&
    r.reason === null &&
    r.windowClose !== null &&
    r.startedAt.getTime() < r.windowClose.getTime() &&
    now.getTime() < r.windowClose.getTime()
  );
}

/** A skip with no reason still waiting for a decision: the person must comment. */
export function needsComment(r: Pick<BreakRecordRow, 'outcome' | 'reason' | 'approvalStatus'>) {
  return isSkipRecord(r) && !r.reason && r.approvalStatus === 'PENDING';
}

export interface NewBreakRecord {
  userId: string;
  date: string;
  kind: BreakKind | null;
  presenceType: BreakPresenceType;
  shiftId: string | null;
  shiftName: string | null;
  scheduledStart: Date | null;
  durationMin: number | null;
  windowOpen: Date | null;
  windowClose: Date | null;
  ringStart: Date | null;
  ringEnd: Date | null;
  startedAt: Date;
  timing: BreakTiming;
  minutesOff: number;
  reason: string | null;
  /** AGENT (the break flow), LEGACY (an older agent's plain break), SYSTEM (an auto-skip). */
  source: 'AGENT' | 'LEGACY' | 'SYSTEM';
  approvalStatus: BreakApprovalStatus;
  approverRole: ApproverRole | null;
  approverId: string | null;
  /** 3.1: TAKEN unless given. */
  outcome?: BreakOutcome;
}

export type StartBreakOutcome =
  | { ok: true; record: BreakRecordRow; presenceSessionId: string; closedMeeting: boolean }
  | { ok: false; reason: 'ALREADY_TAKEN' | 'ALREADY_ON_BREAK' | 'DAY_ENDED' };

export interface Routing {
  approverRole: ApproverRole | null;
  approverId: string | null;
}

export interface ApprovalFilter {
  /** Records routed to this approver. */
  approverId?: string;
  /** Records routed to this approver role (the Super Admin pool). */
  approverRole?: ApproverRole;
  /**
   * A Super Admin's "mine": routed to them by id, or sitting in the role's
   * shared pool (approverRole set, no specific approver).
   */
  approverAny?: { approverId: string; approverRole: ApproverRole };
  status?: BreakApprovalStatus[];
  date?: string;
  /** Strictly before this date (overdue). */
  beforeDate?: string;
  userId?: string;
  skip?: number;
  take?: number;
}

export interface Decision {
  status: 'APPROVED' | 'REJECTED' | 'PENDING';
  decidedById: string | null;
  decidedAt: Date | null;
  note: string | null;
}

/** How a break ended through POST /breaks/end (3.1). */
export interface FinishBreak {
  /** Seconds past the break's length (0 when within it). Always stored. */
  overrunSec: number;
  /**
   * The person asked to count the overrun. `routing` null = nobody reviews them
   * (a Super Admin): the ask is recorded and the status left as it is.
   */
  ask: { reason: string | null; routing: Routing | null } | null;
}

export interface FinishBreakResult {
  row: BreakRecordRow;
  /** True when this call moved the record to PENDING (tell the approver). */
  becamePending: boolean;
}

export interface BreakRecordRepository {
  findById(id: string): Promise<BreakRecordRow | null>;
  /** 3.1: many records at once (approval lists); unknown ids are left out. */
  listByIds(ids: string[]): Promise<BreakRecordRow[]>;
  listForUserOnDate(userId: string, date: string): Promise<BreakRecordRow[]>;
  listForUsersOnDate(userIds: string[], date: string): Promise<BreakRecordRow[]>;
  /** A person's records from `fromDate` to `toDate` inclusive, newest first. */
  listForUserBetween(userId: string, fromDate: string, toDate: string): Promise<BreakRecordRow[]>;
  /** 3.1: many people's records between two days (inclusive), oldest first. */
  listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<BreakRecordRow[]>;
  /** 3.1: the person's skips from `fromDate` on with no reason that are still PENDING. */
  listSkipsNeedingComment(userId: string, fromDate: string): Promise<BreakRecordRow[]>;

  /**
   * Atomically starts a scheduled break: locks the person, refuses when the day
   * was ended, the break was already taken or they are already on a break; then
   * closes any open meeting, opens the presence session and writes the record.
   * A PENDING record gets its 48-hour due time.
   */
  startScheduled(
    record: NewBreakRecord,
    keys: { calendarDay: string },
    now: Date,
  ): Promise<StartBreakOutcome>;

  /** Writes a record for a break an older agent started via /presence/start. */
  createForSession(
    record: NewBreakRecord,
    presenceSessionId: string,
  ): Promise<BreakRecordRow | null>;

  /** The record behind the person's currently open break session, if any. */
  findOpenForUser(userId: string): Promise<BreakRecordRow | null>;

  /**
   * 3.1: stores how the break ended. An ask with routing moves the record to
   * PENDING (reopening a decided one, with a fresh due time); see FinishBreak.
   */
  finishBreak(id: string, input: FinishBreak, now: Date): Promise<FinishBreakResult | null>;

  /**
   * 3.1: the one comment a reason-less skip takes. Conditional: null when the
   * record is not a skip or already has a reason (also when two race).
   */
  addComment(id: string, comment: string, now: Date): Promise<BreakRecordRow | null>;

  listApprovals(filter: ApprovalFilter): Promise<BreakRecordRow[]>;
  countApprovals(filter: ApprovalFilter): Promise<number>;

  /**
   * Applies a decision only if the record is still in `expected` status and its
   * month is not locked (409 MONTH_LOCKED). Back to PENDING restarts the due time.
   * Returns the updated row, or null when it changed meanwhile.
   */
  decide(
    id: string,
    expected: BreakApprovalStatus[],
    decision: Decision,
  ): Promise<BreakRecordRow | null>;

  /** Moves a still-pending record to another approver. False when it was decided meanwhile. */
  reroute(id: string, routing: Routing): Promise<boolean>;
}
