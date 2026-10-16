import { isoWeekdayOfKey } from '@shared/utils/timezone';
import { BREAK_LABEL } from '@modules/shifts/domain/shift.types';
import { outcomeOf } from '@modules/shifts/domain/break-record.repository';
import { overrunSeconds } from '@modules/shifts/domain/break-schedule';
import { meetingsOfDay, PersonDayData } from '@modules/worktime/domain/day';
import {
  dayClassOf,
  expectedSecOf,
  isWorkdayFor,
  lateStartOf,
  ShiftForAttendance,
} from '@modules/worktime/domain/attendance';
import { FocusBreakdown } from '@modules/worktime/domain/focus';
import { activeMinOf, HourActivity, quietHoursOf } from '@modules/worktime/domain/hourly';
import { Interval, intersect, normalize, span, subtract } from '@modules/worktime/domain/intervals';
import { MonthTotals, PersonDaySummary, TimelineSegment } from './report.types';

/**
 * Report arithmetic (SPEC 1.9), as pure functions: one day's summary, a month's
 * totals (always the sum of its days), a team's totals (the sum of its rows), a
 * day's timeline, and the month calendar.
 */

export interface DaySummaryInput {
  date: string;
  today: string;
  data: PersonDayData;
  focus: FocusBreakdown;
  hourly: HourActivity[];
  /** The shift that applied that day (null: no shift at all). */
  shift: (ShiftForAttendance & { overrunGraceMin: number }) | null;
  /** The shift's start that day (for the late start), null without a shift. */
  shiftStart: Date | null;
  pending: number;
  settings: { fullDayPct: number; halfDayPct: number; lateStartGraceMin: number };
  now: Date;
  /** The person's first day (account created): earlier days without work are days off. */
  joinedOn?: string;
}

/** Before the person's first day, and nothing worked: not a working day for them. */
export function beforeJoining(
  date: string,
  joinedOn: string | undefined,
  worked: boolean,
): boolean {
  return !worked && joinedOn !== undefined && date < joinedOn;
}

export function summarizeDay(i: DaySummaryInput): PersonDaySummary {
  const { data: d, focus } = i;
  const workday =
    !beforeJoining(i.date, i.joinedOn, d.sessions.length > 0) && isWorkdayFor(i.shift, i.date);
  const shiftExpected = workday ? expectedSecOf(i.shift) : 0;
  const open = d.sessions.some((s) => s.endedAt === null);
  const first = d.sessions[0] ?? null;
  const last = d.sessions[d.sessions.length - 1] ?? null;
  const graceSec = (i.shift?.overrunGraceMin ?? 3) * 60;
  const taken = d.breakRecords.filter((r) => outcomeOf(r) === 'TAKEN');
  return {
    date: i.date,
    weekday: isoWeekdayOfKey(i.date),
    workday,
    dayClass: dayClassOf({
      date: i.date,
      today: i.today,
      workday,
      spanSec: focus.spanSec,
      focusSec: focus.focusSec,
      expectedSec: shiftExpected,
      fullDayPct: i.settings.fullDayPct,
      halfDayPct: i.settings.halfDayPct,
    }),
    startedAt: first?.startedAt.toISOString() ?? null,
    endedAt: !open && last?.endedAt ? last.endedAt.toISOString() : null,
    autoClosed: !open && last?.endReason === 'AUTO_CLOSED',
    lateStart:
      workday && first
        ? lateStartOf(first.startedAt, i.shiftStart, i.settings.lateStartGraceMin)
        : null,
    focusSec: focus.focusSec,
    // A future working day expects nothing yet, so a month's expected time is
    // always the sum of its days.
    expectedSec: i.date <= i.today ? shiftExpected : 0,
    breakSec: focus.breakSec,
    meetingSec: focus.meetingSec,
    approvedPlusSec: focus.approvedPlusSec,
    rejectedMinusSec: focus.rejectedMinusSec,
    pendingPlusSec: focus.pendingPlusSec,
    pendingMinusSec: focus.pendingMinusSec,
    breaksTaken: taken.length,
    skipped: d.breakRecords.filter((r) => outcomeOf(r) === 'SKIPPED').length,
    autoSkipped: d.breakRecords.filter((r) => outcomeOf(r) === 'AUTO_SKIPPED').length,
    overruns: taken.filter(
      (r) =>
        r.endedAt !== null &&
        (r.overrunSec ?? overrunSeconds(r.durationMin, r.startedAt, r.endedAt, i.now)) > graceSec,
    ).length,
    meetings: meetingsOfDay(d, i.now).count,
    pending: i.pending,
    quietHours: quietHoursOf(i.hourly),
    activeMin: activeMinOf(i.hourly),
  };
}

const SUM_KEYS = [
  'focusSec',
  'expectedSec',
  'skipped',
  'autoSkipped',
  'overruns',
  'meetings',
  'approvedPlusSec',
  'rejectedMinusSec',
  'pending',
  'quietHours',
] as const;

/** A month's totals: every number is the sum (or count) of its days. */
export function monthTotals(
  days: PersonDaySummary[],
  today: string,
  quietHoursFlag: number,
): MonthTotals {
  const workdays = days.filter((d) => d.workday && d.date <= today);
  const workdayFocus = workdays.reduce((s, d) => s + d.focusSec, 0);
  const by = (c: string) => days.filter((d) => d.dayClass === c).length;
  const sums = Object.fromEntries(
    SUM_KEYS.map((k) => [k, days.reduce((s, d) => s + d[k], 0)]),
  ) as Record<(typeof SUM_KEYS)[number], number>;
  return {
    workdays: workdays.length,
    full: by('FULL'),
    half: by('HALF'),
    absent: by('ABSENT'),
    off: by('OFF'),
    extra: by('EXTRA'),
    ...sums,
    avgFocusSec: workdays.length ? Math.round(workdayFocus / workdays.length) : 0,
    lateStarts: days.filter((d) => d.lateStart).length,
    needsALook: sums.quietHours >= quietHoursFlag,
  };
}

/**
 * A team's totals: every number is the sum of its rows; the average focus is
 * over all their working days; it needs a look when anyone does.
 */
export function teamTotals(
  rows: { totals: MonthTotals; days: PersonDaySummary[] }[],
  today: string,
): MonthTotals & { people: number } {
  const keys: (keyof MonthTotals)[] = [
    'workdays',
    'full',
    'half',
    'absent',
    'off',
    'extra',
    'lateStarts',
    ...SUM_KEYS,
  ];
  const sums = Object.fromEntries(
    keys.map((k) => [k, rows.reduce((s, r) => s + (r.totals[k] as number), 0)]),
  ) as Record<string, number>;
  const workdayFocus = rows.reduce(
    (s, r) =>
      s + r.days.filter((d) => d.workday && d.date <= today).reduce((a, d) => a + d.focusSec, 0),
    0,
  );
  return {
    workdays: sums.workdays,
    full: sums.full,
    half: sums.half,
    absent: sums.absent,
    off: sums.off,
    extra: sums.extra,
    focusSec: sums.focusSec,
    expectedSec: sums.expectedSec,
    avgFocusSec: sums.workdays ? Math.round(workdayFocus / sums.workdays) : 0,
    lateStarts: sums.lateStarts,
    skipped: sums.skipped,
    autoSkipped: sums.autoSkipped,
    overruns: sums.overruns,
    meetings: sums.meetings,
    approvedPlusSec: sums.approvedPlusSec,
    rejectedMinusSec: sums.rejectedMinusSec,
    pending: sums.pending,
    quietHours: sums.quietHours,
    needsALook: rows.some((r) => r.totals.needsALook),
    people: rows.length,
  };
}

/** Totals of an empty month (a person with no days to show). */
export function emptyTotals(): MonthTotals {
  return monthTotals([], '0000-00-00', Number.MAX_SAFE_INTEGER);
}

/**
 * The day as segments: WORK, BREAK or LUNCH, MEETING inside the sessions, and OFF
 * between two sessions (End Day then a resume). Sorted by start.
 */
export function buildTimeline(d: PersonDayData, now: Date): TimelineSegment[] {
  const iso = (ms: number) => new Date(ms).toISOString();
  const work = normalize(d.sessions.map((s) => span(s.startedAt, s.endedAt, now)));
  const out: (TimelineSegment & { at: number })[] = [];
  const push = (kind: TimelineSegment['kind'], i: Interval, label: string) =>
    out.push({ kind, startedAt: iso(i.start), endedAt: iso(i.end), label, at: i.start });

  const recordBySession = new Map(
    d.breakRecords
      .filter((r) => r.presenceSessionId)
      .map((r) => [r.presenceSessionId as string, r]),
  );
  const away: Interval[] = [];
  for (const p of d.presence) {
    for (const piece of intersect([span(p.startedAt, p.endedAt, now)], work)) {
      away.push(piece);
      if (p.type === 'MEETING') push('MEETING', piece, p.note ? `Meeting: ${p.note}` : 'Meeting');
      else {
        const rec = recordBySession.get(p.id);
        const label = rec?.kind ? BREAK_LABEL[rec.kind] : p.type === 'LUNCH' ? 'Lunch' : 'Break';
        push(p.type, piece, label);
      }
    }
  }
  for (const m of d.meetingRecords.filter((x) => x.mode === 'PAST')) {
    for (const piece of intersect([span(m.startedAt, m.endedAt, now)], work)) {
      away.push(piece);
      push('MEETING', piece, `Meeting: ${m.agenda}`);
    }
  }
  for (const piece of subtract(work, away)) push('WORK', piece, 'Working');
  for (let i = 1; i < work.length; i++) {
    push('OFF', { start: work[i - 1].end, end: work[i].start }, 'Off');
  }
  return out
    .sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind))
    .map(({ kind, startedAt, endedAt, label }) => ({ kind, startedAt, endedAt, label }));
}

/** Every day of a month, "YYYY-MM-DD". */
export function monthDates(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

/**
 * Month range (SPEC 3.7): from the month of the earliest work session to the
 * current month. Returns the problem, or null when the month is fine.
 */
export function monthRangeProblem(
  month: string,
  currentMonth: string,
  earliestSessionDate: string | null,
): string | null {
  if (month > currentMonth) return 'That month has not happened yet.';
  const earliest = earliestSessionDate ? earliestSessionDate.slice(0, 7) : currentMonth;
  const first = earliest < currentMonth ? earliest : currentMonth;
  if (month < first) return `There is no working time before ${first}.`;
  return null;
}
