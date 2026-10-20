import { ApproverRole } from '@modules/shifts/domain/shift.types';
import { MeetingParticipantData } from './meeting-record.repository';

export const AWAY_REPOSITORY = Symbol('AWAY_REPOSITORY');

/** docs/4.0/SPEC.md 2.5. */
export type AwayStatus = 'UNEXPLAINED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'NOT_REQUIRED';
export type AwayKind = 'THINKING' | 'MEETING' | 'HARDWARE' | 'OTHER' | 'CUSTOM';

export interface AwayRow {
  id: string;
  userId: string;
  companyId: string | null;
  date: string;
  startedAt: Date;
  endedAt: Date | null;
  seconds: number | null;
  reasonKey: string | null;
  reasonKind: AwayKind | null;
  reasonLabel: string | null;
  comment: string | null;
  participants: MeetingParticipantData[];
  momSender: string | null;
  status: AwayStatus;
  approverRole: ApproverRole | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  dueAt: Date | null;
  escalatedAt: Date | null;
  remindedAt: Date | null;
  createdAt: Date;
}

export interface NewAway {
  userId: string;
  companyId: string | null;
  date: string;
  startedAt: Date;
  endedAt: Date;
  reasonKey: string | null;
  reasonKind: AwayKind | null;
  reasonLabel: string | null;
  comment: string | null;
  participants: MeetingParticipantData[];
  momSender: string | null;
  status: AwayStatus;
  approverRole: ApproverRole | null;
  /** SLA clock (PENDING only). */
  dueAt: Date | null;
}

export interface AwayDecision {
  status: 'APPROVED' | 'REJECTED' | 'PENDING';
  decidedById: string | null;
  decidedAt: Date | null;
  note: string | null;
  /** New due time when back to PENDING. */
  dueAt?: Date | null;
}

export type CreateAwayResult =
  | { ok: true; row: AwayRow }
  /** Overlaps an away stretch already recorded (the agent sent it twice, or it overlaps). */
  | { ok: false; code: 'OVERLAP'; existing: AwayRow };

export interface AwayRepository {
  /**
   * Records an away stretch in one transaction under the person's lock: refused
   * when it overlaps one already recorded; a PENDING one in a locked month answers
   * 409 MONTH_LOCKED.
   */
  create(input: NewAway): Promise<CreateAwayResult>;
  findById(id: string): Promise<AwayRow | null>;
  listByIds(ids: string[]): Promise<AwayRow[]>;
  /** Away stretches of these people on days in [fromDate, toDate]. */
  listForUsers(userIds: string[], fromDate: string, toDate: string): Promise<AwayRow[]>;
  /** Routes the person's PENDING away items to `approverRole` (their role or department changed). */
  reroutePending(userId: string, approverRole: ApproverRole): Promise<number>;
  /** Conditional decision (only from an `expected` status); null when it was not. Month lock checked. */
  decide(id: string, expected: AwayStatus[], decision: AwayDecision): Promise<AwayRow | null>;
}
