import { time12InZone as hmInZone } from '@shared/utils/timezone';
import { RecordKind, RECORD_LABEL } from '@modules/shifts/domain/shift.types';

/**
 * What an approval item is, what deciding it does to focus time, and the short
 * lines a manager reads (SPEC 3.4). Pure. Copy rules: plain English, no em dash,
 * no exclamation mark, negatives with a real minus sign, times as h:mm AM in the
 * business timezone (4.0).
 */

export type ApprovalCategory =
  | 'BREAK_EARLY'
  | 'BREAK_LATE'
  | 'BREAK_OUTSIDE'
  | 'BREAK_UNSCHEDULED'
  | 'BREAK_OVERRUN'
  | 'BREAK_SKIP'
  | 'BREAK_AUTO_SKIP'
  | 'MEETING_LIVE'
  | 'MEETING_PAST'
  | 'AWAY_THINKING'
  | 'AWAY_MEETING'
  | 'AWAY_HARDWARE'
  | 'AWAY_OTHER'
  | 'AWAY_CUSTOM';

export const APPROVAL_CATEGORIES: ApprovalCategory[] = [
  'BREAK_EARLY',
  'BREAK_LATE',
  'BREAK_OUTSIDE',
  'BREAK_UNSCHEDULED',
  'BREAK_OVERRUN',
  'BREAK_SKIP',
  'BREAK_AUTO_SKIP',
  'MEETING_LIVE',
  'MEETING_PAST',
  'AWAY_THINKING',
  'AWAY_MEETING',
  'AWAY_HARDWARE',
  'AWAY_OTHER',
  'AWAY_CUSTOM',
];

/** 4.0 away kinds and their default labels (docs/4.0/SPEC.md 2.5). */
export const AWAY_KIND_LABEL: Record<string, string> = {
  THINKING: 'Thinking',
  MEETING: 'Short meeting',
  HARDWARE: 'Working on hardware',
  OTHER: 'Other work',
  CUSTOM: 'Other work',
};

export function awayCategory(kind: string | null): ApprovalCategory {
  switch (kind) {
    case 'THINKING':
      return 'AWAY_THINKING';
    case 'MEETING':
      return 'AWAY_MEETING';
    case 'HARDWARE':
      return 'AWAY_HARDWARE';
    case 'CUSTOM':
      return 'AWAY_CUSTOM';
    default:
      return 'AWAY_OTHER';
  }
}

/** "Away 25 min: Thinking". */
export function awayTitle(label: string | null, kind: string | null, seconds: number): string {
  const what = (label ?? '').trim() || AWAY_KIND_LABEL[kind ?? 'OTHER'] || 'Other work';
  return `Away ${wholeMinutes(seconds)} min: ${what}`;
}

/** "2:05 PM to 2:30 PM · 25 min", plus people and the minutes sender for a short meeting. */
export function awayDetail(
  a: {
    startedAt: Date;
    endedAt: Date | null;
    seconds: number;
    participants: number;
    momSender: string | null;
  },
  tz: string,
): string {
  const end = a.endedAt ?? new Date(a.startedAt.getTime() + a.seconds * 1000);
  const people =
    a.participants > 0
      ? ` · ${a.participants === 1 ? '1 person' : `${a.participants} people`}`
      : '';
  const mom = a.momSender ? ` · minutes by ${a.momSender}` : '';
  return `${hmInZone(a.startedAt, tz)} to ${hmInZone(end, tz)} · ${wholeMinutes(a.seconds)} min${people}${mom}`;
}

export type EffectMode = 'PLUS' | 'MINUS' | 'NONE';

export interface ApprovalEffect {
  mode: EffectMode;
  minutes: number;
  text: string;
}

/** U+2212, the minus sign the copy rules ask for. */
export const MINUS = '−';

export interface BreakCategoryInput {
  outcome: 'TAKEN' | 'SKIPPED' | 'AUTO_SKIPPED';
  overrunAsked: boolean;
  timing: 'ON_TIME' | 'EARLY' | 'LATE' | 'OUTSIDE_WINDOW' | 'UNSCHEDULED';
}

/**
 * A break's category. The overrun wins over early or late when both apply. An
 * on-time break can only be waiting because of its overrun (3.0 data included).
 */
export function breakCategory(r: BreakCategoryInput): ApprovalCategory {
  if (r.outcome === 'SKIPPED') return 'BREAK_SKIP';
  if (r.outcome === 'AUTO_SKIPPED') return 'BREAK_AUTO_SKIP';
  if (r.overrunAsked || r.timing === 'ON_TIME') return 'BREAK_OVERRUN';
  switch (r.timing) {
    case 'EARLY':
      return 'BREAK_EARLY';
    case 'LATE':
      return 'BREAK_LATE';
    case 'OUTSIDE_WINDOW':
      return 'BREAK_OUTSIDE';
    default:
      return 'BREAK_UNSCHEDULED';
  }
}

export function meetingCategory(mode: 'LIVE' | 'PAST'): ApprovalCategory {
  return mode === 'LIVE' ? 'MEETING_LIVE' : 'MEETING_PAST';
}

/** Whole minutes of `sec`, never 0 when there was any time at all. */
export function wholeMinutes(sec: number): number {
  if (sec <= 0) return 0;
  return Math.max(1, Math.round(sec / 60));
}

/**
 * The effect chip. `minutes` is what is at stake: the overrun for BREAK_OVERRUN,
 * the scheduled length for a skip, the meeting length for a meeting.
 */
export function approvalEffect(
  category: ApprovalCategory,
  status: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED',
  minutes: number,
): ApprovalEffect {
  const none = (text = 'No change to focus time'): ApprovalEffect => ({
    mode: 'NONE',
    minutes: 0,
    text,
  });
  const plusKind = category === 'BREAK_OVERRUN' || category.startsWith('AWAY_');
  const minusKind =
    category === 'BREAK_SKIP' ||
    category === 'BREAK_AUTO_SKIP' ||
    category === 'MEETING_LIVE' ||
    category === 'MEETING_PAST';

  if (status === 'PENDING') {
    if (plusKind) return { mode: 'PLUS', minutes, text: `+${minutes} min if approved` };
    if (minusKind) return { mode: 'MINUS', minutes, text: `${MINUS}${minutes} min if rejected` };
    return none();
  }
  if (status === 'APPROVED') {
    if (plusKind) return { mode: 'PLUS', minutes, text: `+${minutes} min added` };
    if (minusKind) return none('Counted as focus time');
    return none();
  }
  if (status === 'REJECTED') {
    if (minusKind) return { mode: 'MINUS', minutes, text: `${MINUS}${minutes} min taken off` };
    return none();
  }
  return none();
}

/** "the morning break", "lunch", "the evening break", "a break". */
export function breakPhrase(kind: RecordKind | null, presenceType: 'BREAK' | 'LUNCH'): string {
  if (kind === 'LUNCH' || (!kind && presenceType === 'LUNCH')) return 'lunch';
  if (kind) return `the ${RECORD_LABEL[kind].toLowerCase()}`;
  return 'a break';
}

export interface BreakTextInput {
  kind: RecordKind | null;
  presenceType: 'BREAK' | 'LUNCH';
  minutesOff: number;
  startedAt: Date;
  endedAt: Date | null;
  scheduledStart: Date | null;
  durationMin: number | null;
  windowOpen: Date | null;
  windowClose: Date | null;
  overrunSec: number;
}

/** "Morning break skipped", "Back 15 min late from lunch", "Lunch break started 20 min late". */
export function breakTitle(category: ApprovalCategory, r: BreakTextInput): string {
  const label = r.kind ? RECORD_LABEL[r.kind] : r.presenceType === 'LUNCH' ? 'Lunch' : 'Break';
  switch (category) {
    case 'BREAK_SKIP':
      return `${label} skipped`;
    case 'BREAK_AUTO_SKIP':
      return `${label} auto-skipped`;
    case 'BREAK_OVERRUN':
      return `Back ${wholeMinutes(r.overrunSec)} min late from ${breakPhrase(r.kind, r.presenceType)}`;
    case 'BREAK_LATE':
      return `${label} started ${r.minutesOff} min late`;
    case 'BREAK_EARLY':
      return `${label} started ${r.minutesOff} min early`;
    case 'BREAK_OUTSIDE':
      return `${r.presenceType === 'LUNCH' ? 'Lunch' : 'Break'} outside the break windows`;
    default:
      return `Unscheduled ${r.presenceType === 'LUNCH' ? 'lunch' : 'break'}`;
  }
}

function windowText(r: BreakTextInput, tz: string): string {
  return r.windowOpen && r.windowClose
    ? ` · window ${hmInZone(r.windowOpen, tz)} to ${hmInZone(r.windowClose, tz)}`
    : '';
}

/** One line: when and how long, e.g. "Skipped at 11:02 · window 10:30 to 12:00". */
export function breakDetail(
  category: ApprovalCategory,
  r: BreakTextInput,
  tz: string,
  now: Date,
): string {
  const at = (d: Date) => hmInZone(d, tz);
  const tookMin = r.endedAt
    ? wholeMinutes((r.endedAt.getTime() - r.startedAt.getTime()) / 1000)
    : null;
  switch (category) {
    case 'BREAK_SKIP':
      return `Skipped at ${at(r.startedAt)}${windowText(r, tz)}`;
    case 'BREAK_AUTO_SKIP':
      return `Auto-skipped at ${at(r.startedAt)}${windowText(r, tz)}`;
    case 'BREAK_OVERRUN': {
      const end = r.endedAt ?? now;
      const took = wholeMinutes((end.getTime() - r.startedAt.getTime()) / 1000);
      const of = r.durationMin ? ` of ${r.durationMin}` : '';
      return `${at(r.startedAt)} to ${at(end)} · ${took} min${of}`;
    }
    case 'BREAK_LATE':
    case 'BREAK_EARLY': {
      const due = r.scheduledStart ? ` · due ${at(r.scheduledStart)}` : '';
      const took = tookMin === null ? ' · on a break now' : ` · ${tookMin} min`;
      return `Started ${at(r.startedAt)}${due}${took}`;
    }
    default: {
      if (!r.endedAt) return `Started ${at(r.startedAt)} · on a break now`;
      return `${at(r.startedAt)} to ${at(r.endedAt)} · ${tookMin} min`;
    }
  }
}

/** "Meeting: Sprint review" (agenda cut at 80 characters). */
export function meetingTitle(agenda: string): string {
  const a = agenda.trim();
  return `Meeting: ${a.length > 80 ? `${a.slice(0, 79)}…` : a}`;
}

/** "10:00 to 10:45 · 45 min · 3 people", or "Started 10:00 · in progress". */
export function meetingDetail(
  m: { startedAt: Date; endedAt: Date | null; durationSec: number; participants: number },
  tz: string,
): string {
  const people =
    m.participants > 0
      ? ` · ${m.participants === 1 ? '1 person' : `${m.participants} people`}`
      : '';
  if (!m.endedAt) return `Started ${hmInZone(m.startedAt, tz)} · in progress${people}`;
  return `${hmInZone(m.startedAt, tz)} to ${hmInZone(m.endedAt, tz)} · ${wholeMinutes(
    m.durationSec,
  )} min${people}`;
}
