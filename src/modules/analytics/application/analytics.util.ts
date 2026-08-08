import { ActivitySampleRecord } from '@modules/activity/domain/activity-sample.repository';
import { MAX_GAP_SEC } from '@modules/activity/application/activity.constants';
import { MeetingWindow } from '@modules/activity/domain/meeting-window.reader';
import { OnlineRow, PresenceRow } from '../domain/analytics.reader';
import { FocusSession } from './analytics.types';

/** A continuous active stretch must reach this to count as a focus session. */
export const FOCUS_SESSION_MIN_SEC = 25 * 60;

/** The `n` local date strings (YYYY-MM-DD) ending at `day`, oldest first. */
export function lastNDatesEndingAt(day: string, n: number): string[] {
  const end = new Date(`${day}T00:00:00`);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    out.push(`${y}-${m}-${dd}`);
  }
  return out;
}

/** Seconds a session contributes: its recorded duration if closed, else live to `now`. */
function sessionSeconds(
  s: { endedAt: Date | null; durationSec: number | null; startedAt: Date },
  now: Date,
): number {
  if (s.endedAt)
    return (
      s.durationSec ?? Math.max(0, Math.round((s.endedAt.getTime() - s.startedAt.getTime()) / 1000))
    );
  return Math.max(0, Math.round((now.getTime() - s.startedAt.getTime()) / 1000));
}

/** Online (working) seconds + the wall-clock span they cover. */
export function computeOnline(
  rows: OnlineRow[],
  now: Date,
): { onlineSec: number; spanSec: number } {
  if (rows.length === 0) return { onlineSec: 0, spanSec: 0 };
  let onlineSec = 0;
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    onlineSec += sessionSeconds(r, now);
    first = Math.min(first, r.startedAt.getTime());
    last = Math.max(last, (r.endedAt ?? now).getTime());
  }
  return { onlineSec, spanSec: Math.max(0, Math.round((last - first) / 1000)) };
}

/**
 * The day's meeting periods, for the daily rollup. A meeting is working time even with
 * the keyboard untouched, so those samples count as active; breaks and lunches are time
 * away and stay idle, hence only MEETING rows are returned.
 */
export function meetingWindows(rows: PresenceRow[]): MeetingWindow[] {
  return rows
    .filter((r) => r.type === 'MEETING')
    .map((r) => ({ start: r.startedAt, end: r.endedAt }));
}

/** Break / lunch / meeting seconds for a day. */
export function presenceTotals(
  rows: PresenceRow[],
  now: Date,
): { breakSec: number; lunchSec: number; meetingSec: number } {
  const t = { breakSec: 0, lunchSec: 0, meetingSec: 0 };
  for (const r of rows) {
    const secs = sessionSeconds(r, now);
    if (r.type === 'BREAK') t.breakSec += secs;
    else if (r.type === 'LUNCH') t.lunchSec += secs;
    else if (r.type === 'MEETING') t.meetingSec += secs;
  }
  return t;
}

/**
 * The heuristic daily productivity score, plus the day's focus time.
 *
 * `focusSec` totals the day's uninterrupted work stretches (see
 * {@link detectFocusSessions}), so it is measured from the same activity samples as
 * `activeSec` and can never exceed it. It used to be `online − meeting`, which
 * counted the idle-threshold grace period before the agent notices nobody is there;
 * once that lead-in was reclassified out of `activeSec`, focus began reporting more
 * work than active — which cannot be true.
 *
 * The score keeps its original online-based basis so existing scores do not shift:
 *   idle      = span − online − break − lunch − meeting
 *   score/10  = productive / (productive + idle),  productive = online (meeting included)
 */
export function computeDayProductivity(
  online: OnlineRow[],
  presence: PresenceRow[],
  now: Date,
  samples: ActivitySampleRecord[] = [],
): { score: number; focusSec: number; idleSec: number; onlineSec: number } {
  const { onlineSec, spanSec } = computeOnline(online, now);
  const { breakSec, lunchSec, meetingSec } = presenceTotals(presence, now);

  const focusSec = detectFocusSessions(samples).reduce((total, s) => total + s.durationSec, 0);

  const idleSec = Math.max(0, spanSec - onlineSec - breakSec - lunchSec - meetingSec);
  const productiveSec = Math.max(0, onlineSec - meetingSec) + meetingSec;
  const denom = productiveSec + idleSec;
  const score = denom > 0 ? Math.round((1000 * productiveSec) / denom) / 100 : 0;

  return { score, focusSec, idleSec, onlineSec };
}

/**
 * Continuous active stretches ≥ {@link FOCUS_SESSION_MIN_SEC}. A run breaks on an
 * idle sample or a gap longer than one sample window (MAX_GAP_SEC).
 */
export function detectFocusSessions(
  samples: ActivitySampleRecord[],
  minSec: number = FOCUS_SESSION_MIN_SEC,
): FocusSession[] {
  const sessions: FocusSession[] = [];
  let start: Date | null = null;
  let end: Date | null = null;
  let active = 0;

  const flush = (): void => {
    if (start && end && active >= minSec) {
      sessions.push({ start: start.toISOString(), end: end.toISOString(), durationSec: active });
    }
    start = null;
    end = null;
    active = 0;
  };

  for (const s of samples) {
    const dur = Math.min(Math.max(0, s.durationSec), MAX_GAP_SEC);
    if (s.idle || dur <= 0) {
      flush();
      continue;
    }
    if (start === null || end === null) {
      start = s.at;
      end = new Date(s.at.getTime() + dur * 1000);
      active = dur;
    } else {
      const gap = (s.at.getTime() - end.getTime()) / 1000;
      if (gap > MAX_GAP_SEC) {
        flush();
        start = s.at;
        end = new Date(s.at.getTime() + dur * 1000);
        active = dur;
      } else {
        end = new Date(s.at.getTime() + dur * 1000);
        active += dur;
      }
    }
  }
  flush();
  return sessions;
}

/** Percent change vs the previous value; `null` when there's no baseline. */
export function deltaPct(today: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((today - prev) / prev) * 1000) / 10;
}
