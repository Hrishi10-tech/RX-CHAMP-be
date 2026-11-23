import { ApproverRole, BreakApprovalStatus } from '@modules/shifts/domain/shift.types';
import { DecisionGuard, Routing } from '@modules/shifts/domain/break-record.repository';
import { AgentGeneration } from './agent-generation';
import { MeetingEndReason, MeetingKind, StatusStartSource } from './meeting-status';
import { PastMeetingConflict } from './meetings';

export const MEETING_RECORD_REPOSITORY = Symbol('MEETING_RECORD_REPOSITORY');

export interface MeetingParticipantData {
  id?: string;
  name: string;
}

export interface MeetingRecordRow {
  id: string;
  userId: string;
  date: string;
  mode: 'LIVE' | 'PAST';
  agenda: string;
  participants: MeetingParticipantData[];
  /** 4.0: who will mail the minutes of meeting. */
  momSender?: string | null;
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number | null;
  presenceSessionId: string | null;
  approvalStatus: BreakApprovalStatus;
  approverRole: ApproverRole | null;
  approverId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  dueAt: Date | null;
  escalatedAt: Date | null;
  remindedAt: Date | null;
  createdAt: Date;
  // ---- 3.6. Always set by the Prisma adapter; optional so rows built by hand (tests) read
  //      as the declared meeting they have always been.
  kind?: MeetingKind;
  startSource?: StatusStartSource | null;
  /** The start, then each "Still in it": the 2 hour check counts from here. */
  confirmedAt?: Date | null;
  endReason?: MeetingEndReason | null;
}

export interface NewMeeting {
  userId: string;
  date: string;
  agenda: string;
  participants: MeetingParticipantData[];
  /** 4.0: who will mail the minutes. */
  momSender?: string | null;
  approvalStatus: 'PENDING' | 'NOT_REQUIRED';
  routing: Routing;
  /** 3.6: a status meeting, and where it started; absent for a declared meeting. */
  status?: { source: StatusStartSource };
}

/** The person's running meeting: its open MEETING presence and its record, if it has one. */
export interface RunningMeeting {
  presenceSessionId: string;
  startedAt: Date;
  /** Null for a meeting started through the older presence calls. */
  record: MeetingRecordRow | null;
}

export type ConfirmStatusResult =
  | { kind: 'CONFIRMED'; record: MeetingRecordRow }
  /** The question went unanswered: too late to confirm, the fallback applies. */
  | { kind: 'TOO_LATE'; record: MeetingRecordRow }
  /** No status meeting is running. */
  | { kind: 'NONE' };

export type StartLiveResult =
  | {
      ok: true;
      record: MeetingRecordRow;
      presenceSessionId: string;
      closedSessionType: string | null;
    }
  | { ok: false; code: 'DAY_NOT_STARTED' | 'DAY_ENDED' | 'ON_BREAK' | 'MEETING_IN_PROGRESS' };

export type EndLiveResult =
  | { kind: 'ENDED'; record: MeetingRecordRow }
  | { kind: 'DISCARDED' }
  /** Already ended earlier (idempotent repeat), or a past meeting. */
  | { kind: 'UNCHANGED'; record: MeetingRecordRow };

export type CreatePastResult =
  | { ok: true; record: MeetingRecordRow }
  | { ok: false; code: 'DAY_NOT_STARTED' }
  | { ok: false; conflict: PastMeetingConflict };

export interface HealResult {
  /** Live meetings whose presence session had closed: now ended. */
  healed: MeetingRecordRow[];
  /** Ones shorter than a minute, deleted. */
  discarded: number;
  discardedIds: string[];
}

export interface MeetingDecision {
  status: 'APPROVED' | 'REJECTED' | 'PENDING';
  decidedById: string | null;
  decidedAt: Date | null;
  note: string | null;
  /** A reopen stores who approves for the person now, in the same write as PENDING. */
  routing?: Routing;
}

/** A live meeting shorter than this is deleted when it ends (SPEC 1.6). */
export const MIN_LIVE_MEETING_SEC = 60;

export interface MeetingRecordRepository {
  findById(id: string): Promise<MeetingRecordRow | null>;
  /** Many records at once (approval lists); unknown ids are left out. */
  listByIds(ids: string[]): Promise<MeetingRecordRow[]>;
  listForUserOnDate(userId: string, date: string): Promise<MeetingRecordRow[]>;
  listForUsersBetween(
    userIds: string[],
    fromDate: string,
    toDate: string,
  ): Promise<MeetingRecordRow[]>;

  /**
   * Starts a live meeting in one transaction: the day must be open (see
   * WorkSessionRepository.ensureOpen), the person not on a break or lunch and
   * not in a meeting; opens the MEETING presence session and the record.
   */
  startLive(
    input: NewMeeting,
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<StartLiveResult>;

  /** Ends a live meeting of `userId` (closing its presence session); discards one under a minute. */
  endLive(id: string, userId: string, now: Date): Promise<EndLiveResult | null>;

  /** Logs an earlier meeting after checking it against the day (pure rules in meetings.ts). */
  createPast(
    input: NewMeeting & { startedAt: Date; durationSec: number },
    generation: AgentGeneration,
    now: Date,
    today: string,
  ): Promise<CreatePastResult>;

  /** Copies the end of a closed presence session onto its live meeting (heal on read). */
  heal(userIds: string[] | null): Promise<HealResult>;

  /**
   * Conditional decision with the month lock (409 MONTH_LOCKED) and the live
   * rule (409 MEETING_IN_PROGRESS); back to PENDING restarts the 48-hour clock.
   * Null when it changed meanwhile (with a `guard`: also when it moved to another approver).
   */
  decide(
    id: string,
    expected: BreakApprovalStatus[],
    decision: MeetingDecision,
    guard?: DecisionGuard,
  ): Promise<MeetingRecordRow | null>;

  /** 3.6: the person's running meeting, whatever its kind; null when there is none. */
  findRunning(userId: string): Promise<RunningMeeting | null>;

  /** 3.6: "Still in it": the running status meeting's 2 hours start again from `now`. */
  confirmStatus(userId: string, now: Date): Promise<ConfirmStatusResult>;

  /** 3.6: running status meetings last confirmed at or before `cutoff` (the 2 hour check). */
  listStatusUnanswered(cutoff: Date, userIds: string[] | null): Promise<MeetingRecordRow[]>;

  /**
   * 3.6: ends one unanswered status meeting at exactly its fallback moment (NO_ANSWER),
   * closing its presence session there. Null when it ended or was confirmed meanwhile.
   */
  endStatusUnanswered(id: string, userId: string, now: Date): Promise<MeetingRecordRow | null>;

  reroute(id: string, routing: Routing): Promise<boolean>;
  listPendingForApprover(approverId: string): Promise<MeetingRecordRow[]>;
  listPendingForUser(userId: string): Promise<MeetingRecordRow[]>;
}
