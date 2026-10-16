import { BreakRecordRow, outcomeOf } from '@modules/shifts/domain/break-record.repository';
import { computeFocus, FocusBreakdown } from './focus';
import { Interval, intersect, lengthMs, normalize, span, toSec } from './intervals';
import { MeetingRecordRow, MIN_LIVE_MEETING_SEC } from './meeting-record.repository';
import { WorkSessionRecord } from './work-session.repository';
import { PresenceRow } from './worktime.reader';

/** Everything one person's day is computed from. */
export interface PersonDayData {
  userId: string;
  date: string;
  /** Work sessions dated `date`, oldest first. */
  sessions: WorkSessionRecord[];
  /** Presence sessions overlapping those sessions (any date). */
  presence: PresenceRow[];
  /** Break records dated `date`. */
  breakRecords: BreakRecordRow[];
  /** Meeting records dated `date`. */
  meetingRecords: MeetingRecordRow[];
}

/** Focus for one loaded day (SPEC 1.3). */
export function focusOfDay(d: PersonDayData, now: Date): FocusBreakdown {
  return computeFocus({
    sessions: d.sessions,
    presence: d.presence,
    breakRecords: d.breakRecords.map((r) => ({
      outcome: outcomeOf(r),
      approvalStatus: r.approvalStatus,
      overrunAsked: r.overrunAsked ?? false,
      overrunSec: r.overrunSec ?? null,
      durationMin: r.durationMin,
    })),
    meetingRecords: d.meetingRecords.map((m) => ({
      mode: m.mode,
      approvalStatus: m.approvalStatus,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
    })),
    now,
  });
}

/** The day's work, break and meeting intervals (hourly activity, timeline). */
export function intervalsOfDay(
  d: PersonDayData,
  now: Date,
): { work: Interval[]; breaks: Interval[]; meetings: Interval[] } {
  return {
    work: d.sessions.map((s) => span(s.startedAt, s.endedAt, now)),
    breaks: d.presence
      .filter((p) => p.type === 'BREAK' || p.type === 'LUNCH')
      .map((p) => span(p.startedAt, p.endedAt, now)),
    meetings: [
      ...d.presence
        .filter((p) => p.type === 'MEETING')
        .map((p) => span(p.startedAt, p.endedAt, now)),
      ...d.meetingRecords
        .filter((m) => m.mode === 'PAST')
        .map((m) => span(m.startedAt, m.endedAt, now)),
    ],
  };
}

/**
 * Meetings of a loaded day: presence meetings in the sessions plus logged ones.
 * A presence meeting shorter than a minute is not counted (a live meeting that
 * short is discarded, SPEC 1.6; focus still treats its seconds as meeting time).
 */
export function meetingsOfDay(d: PersonDayData, now: Date): { count: number; sec: number } {
  const work = normalize(d.sessions.map((s) => span(s.startedAt, s.endedAt, now)));
  const presence = d.presence
    .filter((p) => p.type === 'MEETING')
    .filter((p) => lengthMs([span(p.startedAt, p.endedAt, now)]) >= MIN_LIVE_MEETING_SEC * 1000)
    .filter((p) => lengthMs(intersect([span(p.startedAt, p.endedAt, now)], work)) > 0);
  const past = d.meetingRecords.filter((m) => m.mode === 'PAST');
  const all = [
    ...presence.map((p) => span(p.startedAt, p.endedAt, now)),
    ...past.map((m) => span(m.startedAt, m.endedAt, now)),
  ];
  return { count: presence.length + past.length, sec: toSec(lengthMs(intersect(all, work))) };
}
