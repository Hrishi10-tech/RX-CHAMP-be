import { NO_SHIFT_EXPECTED_SEC } from './attendance';
import { statusFallbackAt, statusPromptAt } from './meeting-status';

/**
 * What the floating icon's ring and status dot read (brief 1.1, 1.8, D-21), as a pure
 * function of the numbers the panel already shows: the ring is today's focus time and a
 * full circle is the day's expected time, so the two always agree.
 */

/** A full circle when the shift sets no target (a day off, a full day of leave, no shift). */
export const DEFAULT_TARGET_SEC = NO_SHIFT_EXPECTED_SEC;

export type DayProgressStatus = 'NOT_STARTED' | 'WORKING' | 'MEETING' | 'BREAK' | 'ENDED';

/** The contract the portal and phone previews call (do not change it). */
export interface DayProgressView {
  status: DayProgressStatus;
  date: string;
  workedSec: number;
  targetSec: number;
  targetFromShift: boolean;
  overSec: number;
  breakStartedAt: string | null;
  breakEndsAt: string | null;
  meetingStartedAt: string | null;
  meetingPromptAt: string | null;
  meetingFallbackAt: string | null;
}

export interface DayProgressInput {
  date: string;
  state: 'NOT_STARTED' | 'OPEN' | 'ENDED';
  /** Today's focus time (computeFocus). */
  focusSec: number;
  /** The day's expected time: shift length minus its breaks, less leave; 0 on a day off. */
  expectedSec: number;
  /** A shift applies to the day. */
  hasShift: boolean;
  /** The person's open break, lunch or meeting, if any. */
  open: { type: 'BREAK' | 'LUNCH' | 'MEETING'; startedAt: Date } | null;
  /** The running break's scheduled length; null for a break off the schedule. */
  breakDurationMin?: number | null;
  /** A running status meeting's last confirmation; null for any other meeting. */
  meetingConfirmedAt?: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function dayProgressOf(i: DayProgressInput): DayProgressView {
  const running = i.state === 'OPEN' ? i.open : null;
  const onBreak = running && running.type !== 'MEETING' ? running : null;
  const inMeeting = running?.type === 'MEETING' ? running : null;
  const status: DayProgressStatus = onBreak
    ? 'BREAK'
    : inMeeting
      ? 'MEETING'
      : i.state === 'OPEN'
        ? 'WORKING'
        : i.state === 'ENDED'
          ? 'ENDED'
          : 'NOT_STARTED';
  const fromShift = i.expectedSec > 0 && i.hasShift;
  const targetSec = i.expectedSec > 0 ? i.expectedSec : DEFAULT_TARGET_SEC;
  const confirmed = inMeeting ? (i.meetingConfirmedAt ?? null) : null;
  return {
    status,
    date: i.date,
    workedSec: i.focusSec,
    targetSec,
    targetFromShift: fromShift,
    overSec: Math.max(0, i.focusSec - targetSec),
    breakStartedAt: iso(onBreak?.startedAt ?? null),
    breakEndsAt:
      onBreak && i.breakDurationMin
        ? new Date(onBreak.startedAt.getTime() + i.breakDurationMin * 60_000).toISOString()
        : null,
    meetingStartedAt: iso(inMeeting?.startedAt ?? null),
    meetingPromptAt: iso(confirmed && statusPromptAt(confirmed)),
    meetingFallbackAt: iso(confirmed && statusFallbackAt(confirmed)),
  };
}
