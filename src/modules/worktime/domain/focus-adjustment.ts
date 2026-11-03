import type { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';

/**
 * Manual focus adjustments (3.3). While a rollout beds in, a bug or a missed
 * Start Day can leave a day's focus time wrong. The Super Manager, and nobody
 * else, may add minutes to or take minutes off one person's day, with a reason.
 * The adjustment enters the day's focus time (and so paid time and attendance)
 * everywhere it is shown, is listed on the day with who made it and why, and
 * the person is told. A mistake is voided, never edited, so the trail is kept.
 * An organisation's Admin or Super Admin can switch the feature off for it
 * (settings, focusAdjustmentsEnabled; 4.0 settings are per organisation).
 */

export interface FocusAdjustmentRecord {
  id: string;
  userId: string;
  date: string;
  /** Signed seconds added to the day's focus time. */
  deltaSec: number;
  reason: string;
  createdById: string;
  createdAt: Date;
  voidedAt: Date | null;
  voidedById: string | null;
}

/** Largest single adjustment either way, in minutes (a full shift). */
export const ADJUSTMENT_MAX_MIN = 12 * 60;
export const ADJUSTMENT_REASON_MIN_CHARS = 5;
export const ADJUSTMENT_REASON_MAX_CHARS = 300;
/** How far back an adjustment may reach, in days (the month lock guards the rest). */
export const ADJUSTMENT_MAX_AGE_DAYS = 62;

/** Only the Super Manager adjusts focus time. */
export function mayAdjustFocus(me: Pick<AuthenticatedUser, 'role'>): boolean {
  return me.role === Role.SUPER_MANAGER;
}

/** Seconds the live (not voided) adjustments add to a day. */
export function adjustedSecOf(
  list: readonly Pick<FocusAdjustmentRecord, 'deltaSec' | 'voidedAt'>[],
): number {
  return list.reduce((sum, a) => (a.voidedAt ? sum : sum + a.deltaSec), 0);
}

export type AdjustmentProblem =
  | { ok: true; deltaSec: number; reason: string }
  | { ok: false; field: 'minutes' | 'reason' | 'date'; message: string };

/** Checks one adjustment as asked for. */
export function checkAdjustment(input: {
  minutes: unknown;
  reason: unknown;
  date: string;
  today: string;
  earliest: string;
}): AdjustmentProblem {
  const minutes = typeof input.minutes === 'number' ? input.minutes : Number.NaN;
  if (!Number.isInteger(minutes) || minutes === 0) {
    return { ok: false, field: 'minutes', message: 'Minutes must be a whole number other than 0.' };
  }
  if (Math.abs(minutes) > ADJUSTMENT_MAX_MIN) {
    return {
      ok: false,
      field: 'minutes',
      message: `At most ${ADJUSTMENT_MAX_MIN} minutes either way in one adjustment.`,
    };
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < ADJUSTMENT_REASON_MIN_CHARS) {
    return {
      ok: false,
      field: 'reason',
      message: `Say why, in at least ${ADJUSTMENT_REASON_MIN_CHARS} characters. The person sees it.`,
    };
  }
  if (reason.length > ADJUSTMENT_REASON_MAX_CHARS) {
    return {
      ok: false,
      field: 'reason',
      message: `Keep the reason under ${ADJUSTMENT_REASON_MAX_CHARS} characters.`,
    };
  }
  if (input.date > input.today) {
    return { ok: false, field: 'date', message: 'That day has not happened yet.' };
  }
  if (input.date < input.earliest) {
    return {
      ok: false,
      field: 'date',
      message: `Adjustments reach back ${ADJUSTMENT_MAX_AGE_DAYS} days at most.`,
    };
  }
  return { ok: true, deltaSec: minutes * 60, reason };
}

/** "+30 min" / "−15 min". */
export function signedMinutes(deltaSec: number): string {
  const min = Math.round(Math.abs(deltaSec) / 60);
  return `${deltaSec < 0 ? '−' : '+'}${min} min`;
}
