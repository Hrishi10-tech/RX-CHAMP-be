import { ApproverRole, BreakApprovalStatus } from '@modules/shifts/domain/shift.types';
import { Routing } from '@modules/shifts/domain/break-record.repository';
import { AgentGeneration } from './agent-generation';
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
}

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
}

export interface MeetingDecision {
  status: 'APPROVED' | 'REJECTED' | 'PENDING';
  decidedById: string | null;
  decidedAt: Date | null;
  note: string | null;
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
   * Null when it changed meanwhile.
   */
  decide(
    id: string,
    expected: BreakApprovalStatus[],
    decision: MeetingDecision,
  ): Promise<MeetingRecordRow | null>;

  reroute(id: string, routing: Routing): Promise<boolean>;
  listPendingForApprover(approverId: string): Promise<MeetingRecordRow[]>;
  listPendingForUser(userId: string): Promise<MeetingRecordRow[]>;
}
