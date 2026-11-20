import { intersect, Interval, lengthMs, normalize, subtract } from './intervals';

/**
 * Keyboard and mouse input, read from the agent's activity samples, as plain
 * functions. One rule set for every place a manager or a Super Admin sees active
 * and idle time, so the same minute is never "active" on one screen and "idle" on
 * another.
 *
 * A sample is the agent's state at `at` and stands until the next sample (the
 * writer stamps `durationSec` from the gap, capped at {@link SAMPLE_CAP_SEC}). The
 * agent only flags a sample idle once nobody has touched the keyboard or mouse for
 * its idle threshold ({@link IDLE_LEAD_IN_SEC}), so the samples of that lead-in
 * still say "active" although nobody was there: they are idle time, and are
 * counted as idle here. A locked workstation is idle from the instant it locks
 * (no lead-in), and the hole a locked, sleeping PC leaves before it reports again
 * is idle too (up to {@link LOCKED_GAP_CAP_SEC}). Time no sample covers is
 * "no data": the agent was not reporting (PC off, agent closed, offline backlog
 * not sent yet). It is never guessed as active or idle.
 */

/** Longest span one sample may stand for (matches the activity writer). */
export const SAMPLE_CAP_SEC = 150;
/** The agent's idle threshold: the stretch before an idle flag that was idle too. */
export const IDLE_LEAD_IN_SEC = 300;
/** Longest unreported stretch after a locked sample that is still credited as idle. */
export const LOCKED_GAP_CAP_SEC = 4 * 60 * 60;
/** Foreground app name of the Windows lock screen (a lock even when the flag is missing). */
export const LOCK_SCREEN_APP_NAME = 'LockApp.exe';

export interface InputSample {
  at: Date;
  durationSec: number;
  idle: boolean;
  locked: boolean;
  app: string | null;
}

export interface InputIntervals {
  /** Disjoint, sorted ms intervals with keyboard or mouse input. */
  active: Interval[];
  /** Disjoint, sorted ms intervals nobody was at the computer (idle, locked, asleep). */
  idle: Interval[];
}

function isLocked(s: InputSample): boolean {
  return s.locked || s.app === LOCK_SCREEN_APP_NAME;
}

/**
 * Turns samples (any order) into active and idle intervals. `now` lets the newest
 * open sample (durationSec 0) stand until now, capped like any other; an open
 * sample that is not the newest stands for nothing.
 */
export function inputIntervals(samples: readonly InputSample[], now: Date): InputIntervals {
  const sorted = [...samples].sort((a, b) => a.at.getTime() - b.at.getTime());
  const capMs = SAMPLE_CAP_SEC * 1000;
  type Slice = { start: number; end: number; idle: boolean; locked: boolean };
  const slices: Slice[] = [];
  sorted.forEach((s, i) => {
    const start = s.at.getTime();
    let lenMs = 0;
    if (s.durationSec > 0) lenMs = Math.min(s.durationSec * 1000, capMs);
    else if (i === sorted.length - 1) lenMs = Math.max(0, Math.min(now.getTime() - start, capMs));
    const locked = isLocked(s);
    slices.push({ start, end: start + lenMs, idle: s.idle || locked, locked });
  });

  const active: Interval[] = [];
  const idle: Interval[] = [];
  for (const s of slices) {
    if (s.end <= s.start) continue;
    (s.idle ? idle : active).push({ start: s.start, end: s.end });
  }

  // The idle lead-in: the threshold before the first sample of each idle stretch
  // (unless it is a lock, which is instantaneous) was idle, not work.
  const leadIns: Interval[] = [];
  let lastIdleEnd = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < slices.length; i++) {
    const s = slices[i];
    if (!s.idle) continue;
    const startsStretch = i === 0 || !slices[i - 1].idle;
    if (startsStretch && !s.locked) {
      const from = Math.max(s.start - IDLE_LEAD_IN_SEC * 1000, lastIdleEnd);
      if (from < s.start) leadIns.push({ start: from, end: s.start });
    }
    lastIdleEnd = Math.max(lastIdleEnd, s.end);
  }

  // A locked PC that went to sleep leaves a hole until it reports again.
  const lockedGaps: Interval[] = [];
  for (let i = 0; i < slices.length - 1; i++) {
    const s = slices[i];
    if (!s.locked) continue;
    const gapStart = s.end;
    const gapEnd = slices[i + 1].start;
    if (gapEnd - s.start > LOCKED_GAP_CAP_SEC * 1000) continue;
    if (gapEnd > gapStart) lockedGaps.push({ start: gapStart, end: gapEnd });
  }

  const reclassified = normalize(leadIns);
  // Input on any device wins over idle on another: the person was working.
  const activeFinal = normalize(subtract(normalize(active), reclassified));
  const idleAll = normalize([...idle, ...lockedGaps, ...intersect(active, reclassified)]);
  return { active: activeFinal, idle: normalize(subtract(idleAll, activeFinal)) };
}

/** Milliseconds of `list` that fall inside `windows`. */
export function overlapIn(list: Interval[], windows: Interval[]): number {
  return lengthMs(intersect(list, windows));
}

export interface InputBreakdown {
  /** Seconds with keyboard or mouse input. */
  activeSec: number;
  /** Seconds nobody was at the computer (idle flag, its lead-in, locked, asleep). */
  idleSec: number;
  /** Seconds the agent did not report at all. */
  noDataSec: number;
  /** Length of the windows that have already happened (up to now). */
  spanSec: number;
}

/** Active, idle and no-data seconds inside `windows`, counting only time up to `now`. */
export function breakdownIn(
  intervals: InputIntervals,
  windows: Interval[],
  now: Date,
): InputBreakdown {
  const past = normalize(
    windows
      .map((w) => ({ start: w.start, end: Math.min(w.end, now.getTime()) }))
      .filter((w) => w.end > w.start),
  );
  const spanMs = past.reduce((s, w) => s + (w.end - w.start), 0);
  const activeMs = overlapIn(intervals.active, past);
  const idleMs = overlapIn(intervals.idle, past);
  const sec = (ms: number) => Math.round(ms / 1000);
  const activeSec = sec(activeMs);
  const idleSec = sec(idleMs);
  const spanSec = sec(spanMs);
  return { activeSec, idleSec, noDataSec: Math.max(0, spanSec - activeSec - idleSec), spanSec };
}

// ---- After a skipped break (Fix 3) ---------------------------------------------------

/** How long after a skip the input is checked. */
export const AFTER_SKIP_WINDOW_MIN = 15;
/** At least this much input in the window reads as "kept working". */
export const AFTER_SKIP_ACTIVE_MIN_SEC = 5 * 60;
/** Under this much input reads as "no input". */
export const AFTER_SKIP_NONE_MAX_SEC = 60;

export type AfterSkipVerdict = 'ACTIVE' | 'LOW' | 'NONE' | 'NO_DATA' | 'PENDING';

export interface AfterSkipActivity {
  /** Start of the check: the skip itself, or the break's start for an auto-skip. */
  from: string;
  to: string;
  windowMin: number;
  basis: 'SKIPPED_AT' | 'BREAK_START';
  activeSec: number;
  idleSec: number;
  noDataSec: number;
  verdict: AfterSkipVerdict;
}

/** The window checked after a skip: 15 minutes from the skip (or the break's start). */
export function afterSkipWindow(
  outcome: 'SKIPPED' | 'AUTO_SKIPPED',
  skippedAt: Date,
  scheduledStart: Date | null,
): { from: Date; to: Date; basis: 'SKIPPED_AT' | 'BREAK_START' } {
  // An auto-skip is written when the window closes; what matters is what the person
  // did when the break was due. A manual skip is judged from the moment it was pressed.
  const auto = outcome === 'AUTO_SKIPPED' && scheduledStart !== null;
  const from = auto ? scheduledStart! : skippedAt;
  return {
    from,
    to: new Date(from.getTime() + AFTER_SKIP_WINDOW_MIN * 60_000),
    basis: auto ? 'BREAK_START' : 'SKIPPED_AT',
  };
}

/** Reads the samples around the window (lead-in included) and judges it. */
export function afterSkipActivity(
  window: { from: Date; to: Date; basis: 'SKIPPED_AT' | 'BREAK_START' },
  samples: readonly InputSample[],
  now: Date,
): AfterSkipActivity {
  const w = { start: window.from.getTime(), end: window.to.getTime() };
  const intervals = inputIntervals(samples, now);
  const b = breakdownIn(intervals, [w], now);
  let verdict: AfterSkipVerdict;
  if (now.getTime() < w.end + IDLE_LEAD_IN_SEC * 1000) {
    // An idle flag up to one threshold after the window still reclassifies its tail.
    verdict = 'PENDING';
  } else if (b.activeSec === 0 && b.idleSec === 0) {
    verdict = 'NO_DATA';
  } else if (b.activeSec >= AFTER_SKIP_ACTIVE_MIN_SEC) {
    verdict = 'ACTIVE';
  } else if (b.activeSec < AFTER_SKIP_NONE_MAX_SEC) {
    verdict = 'NONE';
  } else {
    verdict = 'LOW';
  }
  return {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
    windowMin: AFTER_SKIP_WINDOW_MIN,
    basis: window.basis,
    activeSec: b.activeSec,
    idleSec: b.idleSec,
    noDataSec: b.noDataSec,
    verdict,
  };
}
