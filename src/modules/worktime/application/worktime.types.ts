import type { DayLeaveView } from '@modules/leave/domain/day-leave';
import type { AfterSkipActivity } from '../domain/input-activity';
import type { LateStartDetail } from '../domain/attendance';
import { BreakRecordView, SkipNeedingComment } from '@modules/shifts/application/shifts.types';
import { BreakKind } from '@modules/shifts/domain/shift.types';
import { ApprovalCategory, ApprovalEffect } from '../domain/approval-copy';
import { HourActivity } from '../domain/hourly';
import type { MeetingEndReason, MeetingKind, StatusStartSource } from '../domain/meeting-status';

/**
 * The 3.1 API shapes (SPEC 3). Every `date` is a business-timezone day key, every
 * instant ISO-8601 UTC, durations in seconds unless named ...Min.
 */

export interface FocusView {
  focusSec: number;
  running: boolean;
  spanSec: number;
  breakSec: number;
  meetingSec: number;
  approvedPlusSec: number;
  pendingPlusSec: number;
  rejectedMinusSec: number;
  pendingMinusSec: number;
  // ---- 4.0 (docs/4.0/SPEC.md 2.4)
  paidBreakSec: number;
  unpaidBreakSec: number;
  bufferUsedSec: number;
  quickBreakSec: number;
  awayPendingSec: number;
  awayApprovedSec: number;
  awayRejectedSec: number;
  awayUnexplainedSec: number;
  /** Time in sessions an offline replay opened with no activity data from the agent (not focus, not paid). */
  unverifiedSec: number;
  /** Payroll time: focusSec + paidBreakSec. */
  paidSec: number;
  /** Signed seconds added by hand by the Super Manager (3.3); 0 on an untouched day. */
  adjustedSec: number;
  /** Time worked from home on the phone (3.5), and the part beyond the day's cap (not counted). */
  wfhSec?: number;
  wfhOverSec?: number;
  /** A work-from-home day running on the phone: seconds until focus stops at the cap. */
  capRemainingSec?: number | null;
}

export type WorkdayState = 'NOT_STARTED' | 'OPEN' | 'ENDED';

export interface WorkSessionView {
  startedAt: string;
  endedAt: string | null;
  endReason: 'USER' | 'AUTO_CLOSED' | null;
  /** AGENT, LEGACY, BIOMETRIC (punches) or MOBILE_WFH (the phone), 3.5. */
  source?: string;
}

/** Work from home on the day (3.5). */
export interface WorkdayWfhView {
  /** Days approved (0.25 to 1) and as a label ("Full day", "Half day (first half)"). */
  days: number;
  label: string;
  /** REQUEST, SCHEDULE or BOTH, and in words. */
  source: string;
  sourceLabel: string;
  mask: number;
  /** Waiting for approval (days). */
  pendingDays: number;
  /** The most the day's time from home counts (seconds); biometric staff on the phone. */
  capSec: number;
  /** Biometric staff: the phone may start or end the day now. */
  canStart: boolean;
  canEnd: boolean;
  /** Why it cannot start, in a sentence (null when it can). */
  startBlocked: string | null;
}

/** A biometric punch of the day (3.5). */
export interface WorkdayPunchView {
  at: string;
  direction: 'IN' | 'OUT' | null;
  deviceId: string;
  source: string;
  voided: boolean;
}

export interface ShiftBrief {
  id: string;
  name: string;
  start: string;
  end: string;
}

export interface WorkdayTodayView {
  date: string;
  serverNow: string;
  timezone: string;
  state: WorkdayState;
  startedAt: string | null;
  endedAt: string | null;
  autoClosed: boolean;
  sessions: WorkSessionView[];
  focus: FocusView;
  /**
   * Set when the day's first Start Day came after the shift start plus the grace:
   * minutes late, the reason once given, and whether one is still asked for (3.2).
   */
  lateStart: LateStartDetail | null;
  /** A holiday or a weekly day off by the calendar (3.2); null on a working day. */
  dayOff: { kind: 'HOLIDAY' | 'WEEKLY_OFF'; name: string | null } | null;
  shift: ShiftBrief | null;
  expectedSec: number;
  /**
   * Leave today (3.4): approved (days, full or part, which pools) and any still
   * waiting; null without any. A full day expects nothing; a part day expects the
   * rest of the shift.
   */
  leave?: DayLeaveView | null;
  /** Part-day leave: the part of the shift still to work (late starts count from workingFrom). */
  workingFrom?: string | null;
  workingUntil?: string | null;
  skipsNeedingComment: SkipNeedingComment[];
  overdueApprovals: number;
  endDayBlockedByOverdue: boolean;
  settings: {
    approvalSlaHours: number;
    reasonMinChars: number;
    lateStartGraceMin: number;
    requireLateStartReason: boolean;
    forgottenEndDayIdleMin: number;
    paidBreakBufferMin: number;
  };
  portalUrl: string | null;
  /**
   * NOT_STARTED only: the day the person ended within the last 12 hours (after
   * midnight, or after a night shift), so the agent can show it instead of 0m.
   */
  lastEnded: { date: string; endedAt: string; focusSec: number } | null;
  // ---- 4.0 (docs/4.0/SPEC.md 5.6)
  /** The day's focus target (= expectedSec): shift − scheduled breaks − buffer on a working day. */
  targetSec: number;
  isWorkingDay: boolean;
  /** The calendar's label for the day (a holiday), or null. */
  dayLabel: string | null;
  allowance: {
    scheduledSec: number;
    bufferSec: number;
    totalSec: number;
    /** Paid break time used today (scheduled within their length + buffer used). */
    paidUsedSec: number;
    bufferUsedSec: number;
    unpaidSec: number;
  };
  away: { pendingSec: number; unexplainedSec: number };
  config: {
    idle: {
      enabled: boolean;
      minutes: number;
      reasons: { key: string; label: string; kind: string; fields: string[] }[];
    };
    quickBreakMinutes: number[];
    breakBufferMin: number;
    /**
     * 4.1: the person's department shares one computer between shifts. The agent asks
     * before `shiftEndAt` whether they are taking the next shift and, if not, ends the
     * day and signs out at it.
     */
    sharedComputer: boolean;
    /** Today's shift end (ISO), or null with no shift or on a day off. */
    shiftEndAt: string | null;
    /** The open day was carried on into the next shift (no more questions today). */
    extended: boolean;
  };
  /** How the day is recorded (3.5): AGENT (the desktop app) or BIOMETRIC (punches). */
  attendance?: { source: 'AGENT' | 'BIOMETRIC'; biometricCode: string | null };
  /** Work from home on the day (3.5), or null. */
  wfh?: WorkdayWfhView | null;
  /** Biometric staff (3.5): the day's punches, oldest first. */
  punches?: WorkdayPunchView[];
  /** Biometric staff (3.5): the day was closed with no check-out. */
  checkoutMissing?: boolean;
}

export interface StartDayResponse {
  ok: true;
  date: string;
  resumed: boolean;
  workday: WorkdayTodayView;
}

export interface EndDayResponse {
  ok: true;
  date: string;
  endedAt: string;
  workday: WorkdayTodayView;
}

export interface MeetingParticipant {
  id?: string;
  name: string;
}

export type ApprovalStatusView = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface MeetingRecordView {
  id: string;
  date: string;
  mode: 'LIVE' | 'PAST';
  agenda: string;
  participants: MeetingParticipant[];
  /** 4.0: who will mail the minutes of meeting. */
  momSender: string | null;
  startedAt: string;
  endedAt: string | null;
  inProgress: boolean;
  /** Live seconds while in progress. */
  durationSec: number;
  approvalStatus: ApprovalStatusView;
  dueAt: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedByName: string | null;
  /** 3.6: DECLARED (agenda, participants, approval) or STATUS ("In a meeting"). */
  kind: MeetingKind;
  /** A status meeting: where it started, when it was last confirmed, why it ended. */
  startSource: StatusStartSource | null;
  confirmedAt: string | null;
  endReason: MeetingEndReason | null;
}

export interface CurrentPresenceLite {
  status: 'MEETING';
  sessionId: string;
  note: string | null;
  since: string;
  elapsedSec: number;
}

export interface ApprovalPersonLite {
  id: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  /** 3.3: the person's organisation (combined lists show it as a chip). */
  companyId: string | null;
  companyName: string | null;
  /** The effective avatar (3.6); null while the person has no gender. */
  avatarId: string | null;
}

/** 4.0: an away stretch as an approval item. */
export interface AwayItemView {
  id: string;
  reasonKey: string | null;
  reasonKind: string | null;
  reasonLabel: string | null;
  comment: string | null;
  participants: MeetingParticipant[];
  momSender: string | null;
  startedAt: string;
  endedAt: string | null;
  seconds: number;
}

export interface ApprovalItemView {
  type: 'BREAK' | 'MEETING' | 'AWAY';
  id: string;
  category: ApprovalCategory;
  user: ApprovalPersonLite;
  date: string;
  title: string;
  detail: string;
  reason: string | null;
  needsComment: boolean;
  participants: MeetingParticipant[];
  startedAt: string;
  endedAt: string | null;
  inProgress: boolean;
  durationSec: number;
  effect: ApprovalEffect;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  createdAt: string;
  dueAt: string | null;
  dueInSec: number | null;
  dueSoon: boolean;
  overdue: boolean;
  escalated: boolean;
  decidedAt: string | null;
  /** Who decided it (null while PENDING): the portal offers Reopen to them and Super Admins. */
  decidedById: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  canDecide: boolean;
  locked: boolean;
  /**
   * Skipped and auto-skipped breaks, for Managers and Super Admins only: keyboard and
   * mouse input in the 15 minutes after the skip (or after the break was due). Null
   * on every other item, and always null for the person themself.
   */
  afterSkip: AfterSkipActivity | null;
  break: BreakRecordView | null;
  meeting: MeetingRecordView | null;
  /** 4.0. */
  away: AwayItemView | null;
}

export interface ApprovalsSummaryView31 {
  pending: number;
  dueSoon: number;
  overdue: number;
  escalated: number;
  approvedToday: number;
  rejectedToday: number;
  slaHours: number;
  /** Which items the counts cover: the caller's queue, or the whole organisation. */
  scope: 'mine' | 'all';
  /** The month the counts are limited to, or null for every month. */
  month: string | null;
}

export interface BulkApproveResult31 {
  approved: { type: 'break' | 'meeting' | 'away'; id: string }[];
  skipped: { type: 'break' | 'meeting' | 'away'; id: string; reason: string }[];
}

export type TeamRowStatus =
  | 'NOT_STARTED'
  | 'WORKING'
  | 'BREAK'
  | 'LUNCH'
  | 'MEETING'
  | 'DAY_ENDED'
  /** A full day of approved leave, not started (3.4). */
  | 'ON_LEAVE';

export type TeamBreakStatus =
  | 'UPCOMING'
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'TAKEN'
  | 'SKIPPED'
  | 'AUTO_SKIPPED'
  | 'MISSED';

export interface TeamTodayRow {
  /** The row's working day: the person's own (a night shift past midnight keeps the evening's). */
  date: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
    department: string | null;
    managerId: string | null;
    /** 3.3: the person's organisation (combined lists show it as a chip). */
    companyId?: string | null;
    companyName?: string | null;
    /** The effective avatar (3.6); null while the person has no gender. */
    avatarId: string | null;
  };
  status: TeamRowStatus;
  statusSince: string | null;
  startedAt: string | null;
  endedAt: string | null;
  autoClosed: boolean;
  /** 4.1 shared computer: the person carried their day on into the next shift. */
  extended: boolean;
  lateStart: LateStartDetail | null;
  /** 4.0 calendar: a day the organisation's calendar marks as not working (a holiday). */
  dayOff: { kind: 'HOLIDAY' | 'WEEKLY_OFF'; name: string | null } | null;
  /** Leave that day (3.4): approved, and any still waiting; null without any. */
  leave?: DayLeaveView | null;
  focus: FocusView;
  expectedSec: number;
  /**
   * 3.6: seconds nobody was at the computer, inside the working day and outside breaks and
   * meetings (the day report's input figures); null when the input could not be read.
   */
  idleSec: number | null;
  breaks: {
    kind: BreakKind;
    label: string;
    status: TeamBreakStatus;
    record: BreakRecordView | null;
  }[];
  meetings: { count: number; sec: number };
  pending: number;
  hourly: HourActivity[];
  quietHours: number;
  /** How the day is recorded (3.5). */
  attendance?: 'AGENT' | 'BIOMETRIC';
  /** Work from home that day (3.5), or null. */
  wfh?: WorkdayWfhView | null;
  /** Biometric staff (3.5): the day's punches in short. */
  biometric?: {
    punches: number;
    firstPunchAt: string | null;
    lastPunchAt: string | null;
    checkoutMissing: boolean;
  } | null;
}

export interface TeamTodayView {
  date: string;
  serverNow: string;
  totals: {
    people: number;
    started: number;
    notStarted: number;
    onBreak: number;
    inMeeting: number;
    ended: number;
    /** On a full day of approved leave, not started (3.4). */
    onLeave?: number;
    /** With part of the day on approved leave (3.4). */
    partLeave?: number;
    lateStarts: number;
    /** 3.5 */
    workingFromHome?: number;
    biometric?: number;
    pendingApprovals: number;
    overdueApprovals: number;
    focusSec: number;
    quietHours: number;
  };
  rows: TeamTodayRow[];
}

export interface HourlyActivityView {
  date: string;
  hours: HourActivity[];
  activeMin: number;
  quietHours: number;
}

/** One manual focus adjustment (3.3), as lists and the day report show it. */
export interface FocusAdjustmentView {
  id: string;
  userId: string;
  userName: string;
  /** The person's effective avatar (3.6). */
  avatarId: string | null;
  companyName: string | null;
  date: string;
  /** Signed seconds. */
  deltaSec: number;
  /** "+30 min" or "−15 min". */
  label: string;
  reason: string;
  createdById: string;
  createdByName: string;
  createdAt: string;
  voidedAt: string | null;
  voidedByName: string | null;
}
