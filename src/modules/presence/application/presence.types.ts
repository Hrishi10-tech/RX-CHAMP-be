import { TeamMemberView } from '@shared/types/user.types';
import { PresenceKind } from '../domain/presence-session.repository';

/**
 * WORKING = the implicit state when no session is open. DAY_ENDED outranks all of
 * them: the user pressed "End Day", so they are signed off for the rest of the
 * local day and nothing further accrues.
 */
export type PresenceStatus = 'WORKING' | 'DAY_ENDED' | PresenceKind;

export interface PresenceTotals {
  breakSec: number;
  lunchSec: number;
  meetingSec: number;
  /** Active online (working) seconds, from agent heartbeats. Set by the use case. */
  onlineSec: number;
  /** Online-but-inactive seconds (no input past the agent's idle threshold). Set by the use case. */
  idleSec: number;
}

export interface CurrentPresenceView {
  status: PresenceStatus;
  sessionId: string | null;
  note: string | null;
  /** ISO timestamp the current status began, or null when working. */
  since: string | null;
  /** Seconds elapsed in the current status (0 when working). */
  elapsedSec: number;
}

export interface PresenceSessionView {
  id: string;
  type: PresenceKind;
  note: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Live seconds for an open session; the recorded duration once closed. */
  durationSec: number;
}

export interface TodayPresenceView {
  date: string;
  current: CurrentPresenceView;
  totals: PresenceTotals;
  sessions: PresenceSessionView[];
}

export interface TeamMemberPresenceView extends TeamMemberView {
  status: PresenceStatus;
  note: string | null;
  since: string | null;
  elapsedSec: number;
}

export interface MeetingNoteView {
  note: string;
  startedAt: string;
  durationSec: number;
}

export interface TeamSummaryRowView extends TeamMemberView {
  status: PresenceStatus;
  totals: PresenceTotals;
  meetingNotes: MeetingNoteView[];
  sessionsCount: number;
}

export interface TeamSummaryResult {
  date: string;
  rows: TeamSummaryRowView[];
}

export interface PresenceTimelineBucket {
  start: string; // "HH:mm" (local)
  workSec: number;
  breakSec: number;
  lunchSec: number;
  meetingSec: number;
  /** Online-but-inactive seconds in this hour (no input past the agent's idle threshold). */
  idleSec: number;
}

export interface UserTimelineView {
  userId: string;
  date: string;
  buckets: PresenceTimelineBucket[];
}

export interface UserDailyPresenceView {
  date: string;
  totals: PresenceTotals;
  /** Active, non-meeting work seconds (online − meeting). */
  focusSec: number;
  /** Average online seconds across the whole team that day (for the trend baseline). */
  teamAvgOnlineSec: number;
}

export interface UserPresenceHistoryView extends TeamMemberView {
  days: UserDailyPresenceView[];
}

export interface ProductivityView {
  date: string;
  score: number; // 0–10
  focusSec: number;
  meetingSec: number;
  idleSec: number;
  onlineSec: number;
}
