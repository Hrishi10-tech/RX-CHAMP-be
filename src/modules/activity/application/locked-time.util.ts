import { ActivitySampleRecord } from '../domain/activity-sample.repository';
import { elapsedSeconds } from './activity-date.util';
import { LOCK_GAP_FILL_CAP_SEC, LOCK_SCREEN_APP, MAX_GAP_SEC } from './activity.constants';

/** Idle seconds recovered from one unreported stretch, and the hour they fall in. */
export interface FilledIdle {
  hour: number;
  idleSec: number;
}

/**
 * Whether this sample was taken on a locked workstation.
 *
 * Trusts the agent's flag first and falls back to the lock screen being in the
 * foreground, which is the same fact observed from the other side. See
 * {@link LOCK_SCREEN_APP} for why the fallback carries the weight today.
 */
export function isLockedSample(sample: Pick<ActivitySampleRecord, 'locked' | 'app'>): boolean {
  return sample.locked || sample.app === LOCK_SCREEN_APP;
}

/**
 * Splits a window across the hours it spans, so recovered time lands in the right
 * bars of the hourly chart rather than all in the hour it started.
 */
function byHour(from: Date, to: Date): FilledIdle[] {
  const out: FilledIdle[] = [];
  let cursor = from;
  while (cursor < to) {
    // Start of the next hour after `cursor`.
    const nextHour = new Date(cursor);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    const slice = nextHour < to ? nextHour : to;
    const idleSec = elapsedSeconds(cursor, slice);
    if (idleSec > 0) out.push({ hour: cursor.getHours(), idleSec });
    cursor = slice;
  }
  return out;
}

/**
 * Idle time to credit for stretches the agent never reported because the machine was
 * locked and had gone to sleep.
 *
 * A sample can only carry {@link MAX_GAP_SEC}, so a 46-minute break arrives as one
 * 150-second sample and 43 lost minutes — time the user genuinely spent away, dropped
 * from both columns. Where the workstation was demonstrably locked when reporting
 * stopped, and it resumed soon enough to rule out going home, those seconds are known
 * to be idle and are put back.
 *
 * Deliberately conservative:
 *  - the sample *before* the hole must be locked, which is what proves nobody was
 *    working — the sample after only says when reporting came back, and is often
 *    already active because the user unlocked before the first new sample landed;
 *  - nothing is credited past {@link LOCK_GAP_FILL_CAP_SEC};
 *  - only the part of the hole that no sample already covers is added, so the
 *    150 seconds the closing sample carried are never counted twice;
 *  - a trailing hole has no sample after it and so is never filled, which is what
 *    keeps a machine left locked overnight from billing the night as idle.
 *
 * Everything recovered is idle. None of it reaches active time, app totals or focus
 * sessions — nobody was at the keyboard.
 */
export function fillLockedGaps(samples: ActivitySampleRecord[]): FilledIdle[] {
  const out: FilledIdle[] = [];

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const gapSec = elapsedSeconds(prev.at, samples[i].at);
    // Consecutive samples are a sampling interval apart; anything longer is a hole.
    if (gapSec <= MAX_GAP_SEC) continue;
    if (!isLockedSample(prev)) continue;
    if (gapSec > LOCK_GAP_FILL_CAP_SEC) continue;

    // Whatever the opening sample already accounts for is not lost, so only the
    // remainder is owed. A closed sample is capped at MAX_GAP_SEC by the writer.
    const credited = Math.min(Math.max(0, prev.durationSec), MAX_GAP_SEC);
    if (gapSec - credited <= 0) continue;

    const from = new Date(prev.at.getTime() + credited * 1000);
    out.push(...byHour(from, samples[i].at));
  }

  return out;
}
