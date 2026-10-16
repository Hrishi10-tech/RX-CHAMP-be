import { overlaps, span } from './intervals';
import { MeetingRecordRow, MIN_LIVE_MEETING_SEC } from './meeting-record.repository';

/**
 * Meeting and Start Day rules (SPEC 1.6, 3.1), as pure functions.
 */

export type PastMeetingCode =
  | 'MEETING_OUTSIDE_DAY'
  | 'MEETING_IN_FUTURE'
  | 'MEETING_OVERLAPS_BREAK'
  | 'MEETING_OVERLAPS_MEETING';

export interface PastMeetingConflict {
  code: PastMeetingCode;
  /** What it collides with (overlap errors only). */
  with?: { kind: 'BREAK' | 'LUNCH' | 'MEETING'; startedAt: string; endedAt: string | null };
}

export interface TimedSpan {
  startedAt: Date;
  endedAt: Date | null;
}

export interface PastMeetingInput {
  start: Date;
  end: Date;
  now: Date;
  /** Today's work sessions (an open one counts up to now). */
  sessions: TimedSpan[];
  /** Break and lunch presence sessions of the person. */
  breaks: (TimedSpan & { type: 'BREAK' | 'LUNCH' })[];
  /** The person's other meetings: records (live and past) and MEETING presence sessions. */
  meetings: TimedSpan[];
}

/**
 * Null when an earlier meeting may be logged: it ends no later than now, lies
 * entirely inside one of today's sessions, and overlaps no break, lunch or other
 * meeting. Touching ends do not overlap.
 */
export function checkPastMeeting(i: PastMeetingInput): PastMeetingConflict | null {
  if (i.end.getTime() > i.now.getTime()) return { code: 'MEETING_IN_FUTURE' };
  const inside = i.sessions.some(
    (s) =>
      s.startedAt.getTime() <= i.start.getTime() &&
      i.end.getTime() <= (s.endedAt ?? i.now).getTime(),
  );
  if (!inside) return { code: 'MEETING_OUTSIDE_DAY' };
  const me = span(i.start, i.end, i.now);
  const describe = (kind: 'BREAK' | 'LUNCH' | 'MEETING', s: TimedSpan) => ({
    kind,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
  });
  const brk = i.breaks.find((b) => overlaps(me, span(b.startedAt, b.endedAt, i.now)));
  if (brk) return { code: 'MEETING_OVERLAPS_BREAK', with: describe(brk.type, brk) };
  const other = i.meetings.find((m) => overlaps(me, span(m.startedAt, m.endedAt, i.now)));
  if (other) return { code: 'MEETING_OVERLAPS_MEETING', with: describe('MEETING', other) };
  return null;
}

/** Collapses whitespace and trims; empty means nothing usable. */
export function cleanText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export interface ParticipantInput {
  id?: string;
  name: string;
}

/**
 * Trimmed names, no blanks, each person once (by id, else by name). Ids that are
 * not someone in `knownIds` are dropped (the name stays): a picker id is a hint.
 */
export function cleanParticipants(
  list: ParticipantInput[],
  knownIds: ReadonlySet<string>,
): ParticipantInput[] {
  const out: ParticipantInput[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    const name = cleanText(p.name).slice(0, 80);
    if (!name) continue;
    const id = p.id && knownIds.has(p.id) ? p.id : undefined;
    const key = id ? `id:${id}` : `name:${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id ? { id, name } : { name });
  }
  return out;
}

/** How far back Start Day may be dated by the agent. */
export const START_DAY_BACKDATE_MS = 10 * 60_000;

/**
 * Start Day's optional `startedAt`: accepted only within the last 10 minutes and
 * not in the future; anything else (or nothing) means now.
 */
export function boundedStartedAt(raw: string | null | undefined, now: Date): Date {
  if (!raw) return now;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return now;
  if (t > now.getTime() || now.getTime() - t > START_DAY_BACKDATE_MS) return now;
  return new Date(t);
}

/**
 * A live meeting that ended under a minute is discarded (SPEC 1.6). It is kept as
 * NOT_REQUIRED (so ending it again still says so) and left out of every list.
 */
export function isDiscardedMeeting(
  m: Pick<MeetingRecordRow, 'mode' | 'endedAt' | 'approvalStatus' | 'durationSec'>,
): boolean {
  return (
    m.mode === 'LIVE' &&
    m.endedAt !== null &&
    m.approvalStatus === 'NOT_REQUIRED' &&
    (m.durationSec ?? 0) < MIN_LIVE_MEETING_SEC
  );
}
