import { LeaveKind, LeavePart, LeaveStatus } from '@modules/leave/domain/leave.types';
import { DeciderRole } from '@modules/leave/domain/routing';
import { WfhDayRecord, WfhRequestRecord, WfhScheduleRecord } from './wfh';

export const WFH_REPOSITORY = Symbol('WFH_REPOSITORY');

export interface NewWfhRequest {
  userId: string;
  kind: LeaveKind;
  part: LeavePart | null;
  startDate: string;
  endDate: string;
  units: number;
  reason: string;
  status: LeaveStatus;
  approverRole: DeciderRole | null;
  approverId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
}

export interface WfhRequestPatch {
  status?: LeaveStatus;
  decidedById?: string | null;
  decidedAt?: Date | null;
  decisionNote?: string | null;
  cancelledAt?: Date | null;
  units?: number;
}

export interface WfhRequestFilter {
  userId?: string;
  userIds?: string[];
  statuses?: LeaveStatus[];
  /** Requests overlapping [from, to]. */
  from?: string;
  to?: string;
  limit?: number;
  order?: 'NEWEST' | 'SOONEST';
}

/** A held day of a pending or approved request (other modules, overlap checks). */
export interface HeldWfhDay {
  requestId: string;
  userId: string;
  date: string;
  mask: number;
  units: number;
  status: LeaveStatus;
}

export type NewWfhSchedule = Omit<
  WfhScheduleRecord,
  'id' | 'createdAt' | 'updatedAt' | 'updatedById'
>;

export interface WfhSchedulePatch {
  toDate?: string | null;
  skipDates?: string[];
  note?: string;
  updatedById: string;
}

/** What a transaction holding one person's work-from-home lock may do. */
export interface WfhTx {
  /** 4.0: the lock of the person's organisation. */
  assertMonthOpen(dateKey: string, userId: string): Promise<void>;
  heldDays(
    userId: string,
    from: string,
    to: string,
    exceptRequestId?: string,
  ): Promise<HeldWfhDay[]>;
  findRequest(id: string): Promise<WfhRequestRecord | null>;
  insertRequest(data: NewWfhRequest, days: WfhDayRecord[]): Promise<WfhRequestRecord>;
  updateRequest(
    id: string,
    patch: WfhRequestPatch,
    days?: WfhDayRecord[],
  ): Promise<WfhRequestRecord>;
  schedulesOf(userId: string): Promise<WfhScheduleRecord[]>;
  /** Days held (waiting or approved) in a month, for the monthly cap. */
  unitsInMonth(userId: string, month: string, exceptRequestId?: string): Promise<number>;
}

export interface WfhRepository {
  inUserLock<T>(userId: string, fn: (tx: WfhTx) => Promise<T>): Promise<T>;
  findRequest(id: string): Promise<WfhRequestRecord | null>;
  listRequests(filter: WfhRequestFilter): Promise<WfhRequestRecord[]>;
  heldDaysOf(userIds: string[], from: string, to: string): Promise<HeldWfhDay[]>;
  /** Pending requests with a day in this month (a month lock waits for them). */
  pendingInMonth(month: string, userIds?: string[]): Promise<number>;

  findSchedule(id: string): Promise<WfhScheduleRecord | null>;
  /** Schedules of these people (every person when undefined) that are in force on some day of [from, to]. */
  schedulesBetween(
    userIds: string[] | undefined,
    from: string,
    to: string,
  ): Promise<WfhScheduleRecord[]>;
  insertSchedule(data: NewWfhSchedule): Promise<WfhScheduleRecord>;
  updateSchedule(id: string, patch: WfhSchedulePatch): Promise<WfhScheduleRecord>;
  deleteSchedule(id: string): Promise<boolean>;
}
