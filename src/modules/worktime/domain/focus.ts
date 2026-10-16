import { Interval, intersect, lengthMs, normalize, toSec } from './intervals';

/**
 * Focus time (SPEC 1.3), as a pure function of one person's day.
 *
 *   spanSec          = |W|                      W = the day's work sessions (open = to now)
 *   breakSec         = |BREAK and LUNCH presence ∩ W|
 *   meetingSec       = |(MEETING presence ∪ PAST meeting records) ∩ W|   (information only)
 *   base             = spanSec − breakSec
 *   approvedPlusSec  = Σ overrunSec of TAKEN records with overrunAsked and APPROVED
 *   pendingPlusSec   = the same for PENDING
 *   rejectedMinusSec = Σ |meeting ∩ W| of REJECTED meetings + Σ durationMin×60 of REJECTED skips
 *   pendingMinusSec  = the same two sums for PENDING
 *   focusSec         = max(0, base + approvedPlusSec − rejectedMinusSec)
 *
 * Keyboard and mouse activity never enters it. Every instant is floored to the
 * whole second before any interval is built, so every part is a whole number of
 * seconds and the formula holds exactly on the numbers returned (the portal
 * rebuilds "time worked" from them); so do the "if approved" and "if rejected"
 * variants with the pending parts.
 */

export type FocusApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

export interface FocusSession {
  startedAt: Date;
  endedAt: Date | null;
}

export interface FocusPresence {
  type: 'BREAK' | 'LUNCH' | 'MEETING';
  startedAt: Date;
  endedAt: Date | null;
}

export interface FocusBreakRecord {
  outcome: 'TAKEN' | 'SKIPPED' | 'AUTO_SKIPPED';
  approvalStatus: FocusApprovalStatus;
  overrunAsked: boolean;
  overrunSec: number | null;
  durationMin: number | null;
}

export interface FocusMeetingRecord {
  mode: 'LIVE' | 'PAST';
  approvalStatus: FocusApprovalStatus;
  startedAt: Date;
  /** Null while a live meeting runs (counts to now). */
  endedAt: Date | null;
}

export interface FocusInput {
  /** The person's work sessions dated D. */
  sessions: FocusSession[];
  /** Presence sessions that may overlap them (any date; clipped to W here). */
  presence: FocusPresence[];
  /** Break records dated D. */
  breakRecords: FocusBreakRecord[];
  /** Meeting records dated D. */
  meetingRecords: FocusMeetingRecord[];
  now: Date;
}

export interface FocusBreakdown {
  focusSec: number;
  /** A session is open and the person is not on a break or lunch (meetings tick). */
  running: boolean;
  spanSec: number;
  breakSec: number;
  meetingSec: number;
  approvedPlusSec: number;
  pendingPlusSec: number;
  rejectedMinusSec: number;
  pendingMinusSec: number;
}

export const EMPTY_FOCUS: Readonly<FocusBreakdown> = Object.freeze({
  focusSec: 0,
  running: false,
  spanSec: 0,
  breakSec: 0,
  meetingSec: 0,
  approvedPlusSec: 0,
  pendingPlusSec: 0,
  rejectedMinusSec: 0,
  pendingMinusSec: 0,
});

function isSkip(r: FocusBreakRecord): boolean {
  return r.outcome === 'SKIPPED' || r.outcome === 'AUTO_SKIPPED';
}

/** An instant floored to the whole second. */
const wholeSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

/** [start, end or now) on whole seconds: its length, and any overlap, is whole seconds. */
function wholeSpan(start: Date, end: Date | null, now: Date): Interval {
  const s = wholeSecond(start.getTime());
  const e = wholeSecond((end ?? now).getTime());
  return { start: s, end: Math.max(s, e) };
}

export function computeFocus(input: FocusInput): FocusBreakdown {
  const { now } = input;
  const work: Interval[] = normalize(
    input.sessions.map((s) => wholeSpan(s.startedAt, s.endedAt, now)),
  );

  const breaks = input.presence
    .filter((p) => p.type === 'BREAK' || p.type === 'LUNCH')
    .map((p) => wholeSpan(p.startedAt, p.endedAt, now));
  const meetings = [
    ...input.presence
      .filter((p) => p.type === 'MEETING')
      .map((p) => wholeSpan(p.startedAt, p.endedAt, now)),
    ...input.meetingRecords
      .filter((m) => m.mode === 'PAST')
      .map((m) => wholeSpan(m.startedAt, m.endedAt, now)),
  ];

  // Every length below is a whole number of seconds (whole-second instants).
  const spanSec = toSec(lengthMs(work));
  const breakSec = toSec(lengthMs(intersect(work, breaks)));
  const meetingSec = toSec(lengthMs(intersect(work, meetings)));

  let approvedPlusSec = 0;
  let pendingPlusSec = 0;
  let rejectedMinusSec = 0;
  let pendingMinusSec = 0;

  for (const r of input.breakRecords) {
    if (r.outcome === 'TAKEN' && r.overrunAsked) {
      const plus = Math.max(0, Math.round(r.overrunSec ?? 0));
      if (r.approvalStatus === 'APPROVED') approvedPlusSec += plus;
      else if (r.approvalStatus === 'PENDING') pendingPlusSec += plus;
    } else if (isSkip(r)) {
      const minus = Math.max(0, Math.round((r.durationMin ?? 0) * 60));
      if (r.approvalStatus === 'REJECTED') rejectedMinusSec += minus;
      else if (r.approvalStatus === 'PENDING') pendingMinusSec += minus;
    }
  }
  for (const m of input.meetingRecords) {
    if (m.approvalStatus !== 'REJECTED' && m.approvalStatus !== 'PENDING') continue;
    const minus = toSec(lengthMs(intersect([wholeSpan(m.startedAt, m.endedAt, now)], work)));
    if (m.approvalStatus === 'REJECTED') rejectedMinusSec += minus;
    else pendingMinusSec += minus;
  }

  const open = input.sessions.some((s) => s.endedAt === null);
  const onBreak = input.presence.some(
    (p) => p.endedAt === null && (p.type === 'BREAK' || p.type === 'LUNCH'),
  );

  return {
    focusSec: Math.max(0, spanSec - breakSec + approvedPlusSec - rejectedMinusSec),
    running: open && !onBreak,
    spanSec,
    breakSec,
    meetingSec,
    approvedPlusSec,
    pendingPlusSec,
    rejectedMinusSec,
    pendingMinusSec,
  };
}
