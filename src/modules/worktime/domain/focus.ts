import { Interval, intersect, joinGaps, lengthMs, normalize, subtract, toSec } from './intervals';

/**
 * Focus time (4.0: docs/4.0/SPEC.md 2.4; 3.1 SPEC 1.3), as a pure function of one
 * person's day.
 *
 *   W                = the day's work sessions (open = to now)
 *   spanSec          = |W|
 *   breakSec         = |BREAK and LUNCH presence ∩ W|            (all break time; never focus)
 *   takenK           = |segments of scheduled break K ∩ W|
 *   paidScheduledSec = Σ min(takenK, durationK)
 *   overrunSec       = Σ max(0, takenK − durationK)
 *   quickBreakSec    = |segments of QUICK breaks ∩ W|            (away breaks included)
 *   otherBreakSec    = breakSec − Σ takenK − quickBreakSec       (unscheduled and legacy)
 *   bufferUsedSec    = min(bufferMin·60, overrunSec + quickBreakSec + otherBreakSec)
 *   paidBreakSec     = paidScheduledSec + bufferUsedSec
 *   unpaidBreakSec   = breakSec − paidBreakSec
 *   away<STATUS>Sec  = |away events of that status ∩ W − breaks|
 *   approvedPlusSec  = Σ overrunSec of TAKEN records with overrunAsked and APPROVED (3.x)
 *   rejectedMinusSec = Σ |meeting ∩ W| of REJECTED meetings + Σ durationMin×60 of REJECTED skips
 *   focusSec         = max(0, spanSec − breakSec − awayPending − awayRejected − awayUnexplained
 *                              + approvedPlusSec − rejectedMinusSec)
 *   pendingPlusSec   = awayPending + the PENDING overrun asks (3.x)     ("+N min if approved")
 *
 * Offline evidence (4.0): a REPLAY session (opened or reopened by an action the
 * agent replayed after being offline) counts only where evidence covers it: the
 * agent's activity samples and manager-approved time (approved away, approved
 * meetings), gaps up to COVERAGE_JOIN_SEC joined; a session's start or end only
 * stretches evidence within COVERAGE_JOIN_SEC of it, never covers alone. Its
 * uncovered part outside other away time and rejected meetings is unverified:
 *
 *   uncovered        = REPLAY sessions − evidence − away − rejected meetings
 *   unverifiedSec    = |uncovered − breaks|        (break time there is unpaid break)
 *   focusSec        −= unverifiedSec                            (never focus)
 *   paidBreakSec     = min(paid, breakSec − |uncovered ∩ breaks|)
 *   paidScheduledSec, bufferUsedSec = the paid break split (scheduled first)
 *   paidSec          = focusSec + paidBreakSec                  (payroll)
 *
 * Live (non-REPLAY) sessions are unchanged: their span counts as before.
 *
 * Approved away time is inside the span and simply not subtracted. Keyboard and
 * mouse activity never enters it. Every instant is floored to the whole second
 * before any interval is built, so every part is a whole number of seconds and the
 * formula holds exactly on the numbers returned.
 */
export type FocusApprovalStatus = 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';

/** Activity samples this close together (or to a REPLAY session's start or end) cover the time between. */
export const COVERAGE_JOIN_SEC = 120;

export interface FocusSession {
  startedAt: Date;
  endedAt: Date | null;
  /** 4.0: opened by a replayed offline action (source REPLAY): counts only where covered. */
  replay?: boolean;
}

/** 4.0: a stretch covered by the agent's activity samples. */
export interface FocusCoverage {
  startedAt: Date;
  endedAt: Date;
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
  /** 4.0: MORNING/LUNCH/EVENING (scheduled), QUICK, or null (unscheduled). */
  kind?: string | null;
  /** 4.0: the break's segments (open ones run to now). Empty for skips. */
  segments?: { startedAt: Date; endedAt: Date | null }[];
}

/** 4.0: an away stretch (docs/4.0/SPEC.md 2.5). */
export interface FocusAway {
  status: 'UNEXPLAINED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'NOT_REQUIRED';
  startedAt: Date;
  endedAt: Date | null;
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
  /** 4.0: away stretches dated D. */
  away?: FocusAway[];
  /** 4.0: the organisation's paid buffer on top of the scheduled breaks (minutes). */
  bufferMin?: number;
  /** 4.0: what the agent's activity samples cover of the REPLAY sessions. */
  coverage?: FocusCoverage[];
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
  // ---- 4.0 allowance and away (docs/4.0/SPEC.md 2.4)
  scheduledTakenSec: number;
  paidScheduledSec: number;
  overrunSec: number;
  quickBreakSec: number;
  otherBreakSec: number;
  bufferUsedSec: number;
  paidBreakSec: number;
  unpaidBreakSec: number;
  awayPendingSec: number;
  awayApprovedSec: number;
  awayRejectedSec: number;
  awayUnexplainedSec: number;
  /** 4.0: time in REPLAY sessions with no activity data (never focus, never paid). */
  unverifiedSec: number;
  /** 4.0: payroll time, focusSec + paidBreakSec. */
  paidSec: number;
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
  scheduledTakenSec: 0,
  paidScheduledSec: 0,
  overrunSec: 0,
  quickBreakSec: 0,
  otherBreakSec: 0,
  bufferUsedSec: 0,
  paidBreakSec: 0,
  unpaidBreakSec: 0,
  awayPendingSec: 0,
  awayApprovedSec: 0,
  awayRejectedSec: 0,
  awayUnexplainedSec: 0,
  unverifiedSec: 0,
  paidSec: 0,
});

const SCHEDULED = new Set(['MORNING', 'LUNCH', 'EVENING']);

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
  const breakInW = intersect(work, breaks);
  const breakSec = toSec(lengthMs(breakInW));
  const meetingSec = toSec(lengthMs(intersect(work, meetings)));

  let approvedPlusSec = 0;
  let pendingPlusSec = 0;
  let rejectedMinusSec = 0;
  let pendingMinusSec = 0;

  // 4.0 allowance: scheduled breaks are paid up to their length, quick and other
  // break time (and overruns) only out of the buffer.
  let scheduledTakenSec = 0;
  let paidScheduledSec = 0;
  let overrunSec = 0;
  let quickBreakSec = 0;

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
    if (r.outcome !== 'TAKEN' || !r.segments?.length) continue;
    const segs = r.segments.map((g) => wholeSpan(g.startedAt, g.endedAt, now));
    const taken = toSec(lengthMs(intersect(work, segs)));
    if (r.kind === 'QUICK') {
      quickBreakSec += taken;
    } else if (r.kind && SCHEDULED.has(r.kind)) {
      const lengthSec = Math.max(0, Math.round((r.durationMin ?? 0) * 60));
      scheduledTakenSec += taken;
      paidScheduledSec += Math.min(taken, lengthSec);
      overrunSec += Math.max(0, taken - lengthSec);
    }
  }
  // Segment time can never exceed break presence time (they are the same sessions).
  scheduledTakenSec = Math.min(scheduledTakenSec, breakSec);
  paidScheduledSec = Math.min(paidScheduledSec, scheduledTakenSec);
  quickBreakSec = Math.min(quickBreakSec, Math.max(0, breakSec - scheduledTakenSec));
  const otherBreakSec = Math.max(0, breakSec - scheduledTakenSec - quickBreakSec);
  const bufferSec = Math.max(0, Math.round((input.bufferMin ?? 0) * 60));
  const bufferUsedSec = Math.min(bufferSec, overrunSec + quickBreakSec + otherBreakSec);
  const rejectedMeetings: Interval[] = [];
  for (const m of input.meetingRecords) {
    if (m.approvalStatus !== 'REJECTED' && m.approvalStatus !== 'PENDING') continue;
    const inWork = intersect([wholeSpan(m.startedAt, m.endedAt, now)], work);
    const minus = toSec(lengthMs(inWork));
    if (m.approvalStatus === 'REJECTED') {
      rejectedMinusSec += minus;
      rejectedMeetings.push(...inWork);
    } else pendingMinusSec += minus;
  }

  // 4.0 away time: inside the span, outside breaks, by status.
  const notBreak = subtract(work, breakInW);
  const awaySpans = (input.away ?? []).map((a) => ({
    status: a.status,
    span: wholeSpan(a.startedAt, a.endedAt, now),
  }));
  const awaySec = (status: FocusAway['status']) =>
    toSec(
      lengthMs(
        intersect(
          notBreak,
          awaySpans.filter((a) => a.status === status).map((a) => a.span),
        ),
      ),
    );
  const awayPendingSec = awaySec('PENDING');
  const awayApprovedSec = awaySec('APPROVED');
  const awayRejectedSec = awaySec('REJECTED');
  const awayUnexplainedSec = awaySec('UNEXPLAINED');
  pendingPlusSec += awayPendingSec;

  // 4.0 offline evidence: REPLAY time the agent's samples do not cover, outside
  // away time (already decided by its status) and rejected meetings (already off).
  // Manager-approved time is evidence like the samples: approved away and
  // approved meetings (live or logged).
  const approvedEvidence = [
    ...awaySpans.filter((a) => a.status === 'APPROVED').map((a) => a.span),
    ...input.meetingRecords
      .filter((m) => m.approvalStatus === 'APPROVED')
      .map((m) => wholeSpan(m.startedAt, m.endedAt, now)),
  ];
  const unverified = unverifiedIntervals(
    input,
    work,
    [...awaySpans.filter((a) => a.status !== 'APPROVED').map((a) => a.span), ...rejectedMeetings],
    approvedEvidence,
  );
  const unverifiedAllSec = toSec(lengthMs(unverified));
  const unverifiedBreakSec = toSec(lengthMs(intersect(unverified, breakInW)));
  // Break time inside unverified time is break time (unpaid), never reported twice:
  // unverifiedSec is the working part only.
  const unverifiedSec = unverifiedAllSec - unverifiedBreakSec;
  const paidBreakSec = Math.max(
    0,
    Math.min(breakSec - unverifiedBreakSec, paidScheduledSec + bufferUsedSec),
  );
  const unpaidBreakSec = Math.max(0, breakSec - paidBreakSec);
  // What was actually paid, split as before: scheduled minutes first, then the buffer.
  const paidScheduledShown = Math.min(paidScheduledSec, paidBreakSec);
  const bufferUsedShown = paidBreakSec - paidScheduledShown;

  const open = input.sessions.some((s) => s.endedAt === null);
  const onBreak = input.presence.some(
    (p) => p.endedAt === null && (p.type === 'BREAK' || p.type === 'LUNCH'),
  );
  const focusSec = Math.max(
    0,
    spanSec -
      breakSec -
      awayPendingSec -
      awayRejectedSec -
      awayUnexplainedSec +
      approvedPlusSec -
      rejectedMinusSec -
      unverifiedSec,
  );

  return {
    focusSec,
    running: open && !onBreak,
    spanSec,
    breakSec,
    meetingSec,
    approvedPlusSec,
    pendingPlusSec,
    rejectedMinusSec,
    pendingMinusSec,
    scheduledTakenSec,
    paidScheduledSec: paidScheduledShown,
    overrunSec,
    quickBreakSec,
    otherBreakSec,
    bufferUsedSec: bufferUsedShown,
    paidBreakSec,
    unpaidBreakSec,
    awayPendingSec,
    awayApprovedSec,
    awayRejectedSec,
    awayUnexplainedSec,
    unverifiedSec,
    paidSec: focusSec + paidBreakSec,
  };
}

/**
 * The parts of the REPLAY sessions (inside the work span) that no evidence
 * covers, minus `explained` (away time already decided against focus, rejected
 * meetings). Evidence is the agent's activity samples plus `approved` time
 * (approved away, approved meetings); its pieces join across gaps of at most
 * COVERAGE_JOIN_SEC. A REPLAY session's start or end only stretches a piece of
 * evidence that begins or ends within COVERAGE_JOIN_SEC of it (the minute before
 * the first sample, after the last one): it never covers anything by itself, and
 * two sessions' edges never join, so a replayed session with no evidence is
 * unverified from end to end however short it is.
 */
function unverifiedIntervals(
  input: FocusInput,
  work: Interval[],
  explained: Interval[],
  approved: Interval[],
): Interval[] {
  const { now } = input;
  const replay = input.sessions
    .filter((s) => s.replay)
    .map((s) => wholeSpan(s.startedAt, s.endedAt, now));
  if (!replay.length) return [];
  const replayWork = intersect(work, replay);
  if (!replayWork.length) return [];
  const join = COVERAGE_JOIN_SEC * 1000;
  const pieces = joinGaps(
    [...(input.coverage ?? []).map((c) => wholeSpan(c.startedAt, c.endedAt, now)), ...approved],
    join,
  );
  const edges: Interval[] = [];
  for (const r of replay) {
    for (const c of pieces) {
      if (c.end < r.start || c.start > r.end) continue;
      if (c.start > r.start && c.start - r.start <= join) {
        edges.push({ start: r.start, end: c.start });
      }
      if (c.end < r.end && r.end - c.end <= join) edges.push({ start: c.end, end: r.end });
    }
  }
  const covered = normalize([...pieces, ...edges]);
  return subtract(subtract(replayWork, covered), explained);
}
