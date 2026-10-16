import { BreakRecordView, SkipNeedingComment } from '@modules/shifts/application/shifts.types';
import { BreakKind } from '@modules/shifts/domain/shift.types';
import { ApprovalCategory, ApprovalEffect } from '../domain/approval-copy';
import { HourActivity } from '../domain/hourly';

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
}

export type WorkdayState = 'NOT_STARTED' | 'OPEN' | 'ENDED';

export interface WorkSessionView {
  startedAt: string;
  endedAt: string | null;
  endReason: 'USER' | 'AUTO_CLOSED' | null;
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
  lateStart: { minutes: number } | null;
  shift: ShiftBrief | null;
  expectedSec: number;
  skipsNeedingComment: SkipNeedingComment[];
  overdueApprovals: number;
  endDayBlockedByOverdue: boolean;
  settings: { approvalSlaHours: number; reasonMinChars: number };
  portalUrl: string | null;
  /**
   * NOT_STARTED only: the day the person ended within the last 12 hours (after
   * midnight, or after a night shift), so the agent can show it instead of 0m.
   */
  lastEnded: { date: string; endedAt: string; focusSec: number } | null;
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
}

export interface ApprovalItemView {
  type: 'BREAK' | 'MEETING';
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
  break: BreakRecordView | null;
  meeting: MeetingRecordView | null;
}

export interface ApprovalsSummaryView31 {
  pending: number;
  dueSoon: number;
  overdue: number;
  escalated: number;
  approvedToday: number;
  rejectedToday: number;
  slaHours: number;
}

export interface BulkApproveResult31 {
  approved: { type: 'break' | 'meeting'; id: string }[];
  skipped: { type: 'break' | 'meeting'; id: string; reason: string }[];
}

export type TeamRowStatus = 'NOT_STARTED' | 'WORKING' | 'BREAK' | 'LUNCH' | 'MEETING' | 'DAY_ENDED';

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
  };
  status: TeamRowStatus;
  statusSince: string | null;
  startedAt: string | null;
  endedAt: string | null;
  autoClosed: boolean;
  lateStart: { minutes: number } | null;
  focus: FocusView;
  expectedSec: number;
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
    lateStarts: number;
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
