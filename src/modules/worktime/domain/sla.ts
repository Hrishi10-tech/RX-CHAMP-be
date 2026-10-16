/**
 * The 48-hour rule (SPEC 1.7), as pure functions.
 *
 * Every time an item becomes PENDING its dueAt restarts at now + approvalSlaHours.
 * Overdue: now > dueAt. Due soon: not overdue and dueAt − now ≤ 12h (the two are
 * kept exclusive so a row shows one chip, never both).
 */

export const DUE_SOON_MS = 12 * 60 * 60_000;
export const DIGEST_DUE_MS = 24 * 60 * 60_000;

export function dueAtFrom(now: Date, slaHours: number): Date {
  return new Date(now.getTime() + slaHours * 60 * 60_000);
}

export interface SlaState {
  /** Seconds until due (negative when overdue); null when not pending or no due date. */
  dueInSec: number | null;
  dueSoon: boolean;
  overdue: boolean;
}

export function slaState(status: string, dueAt: Date | null, now: Date): SlaState {
  if (status !== 'PENDING' || !dueAt) return { dueInSec: null, dueSoon: false, overdue: false };
  const leftMs = dueAt.getTime() - now.getTime();
  const overdue = leftMs < 0;
  return {
    dueInSec: Math.round(leftMs / 1000),
    dueSoon: !overdue && leftMs <= DUE_SOON_MS,
    overdue,
  };
}

/** Reminder candidates: pending, not yet reminded, due within 12h and not overdue. */
export function needsReminder(
  item: { dueAt: Date | null; remindedAt: Date | null },
  now: Date,
): boolean {
  if (!item.dueAt || item.remindedAt) return false;
  const left = item.dueAt.getTime() - now.getTime();
  return left >= 0 && left <= DUE_SOON_MS;
}

/** Escalation candidates: pending, past due and not yet escalated. */
export function needsEscalation(
  item: { dueAt: Date | null; escalatedAt: Date | null },
  now: Date,
): boolean {
  return !!item.dueAt && !item.escalatedAt && now.getTime() > item.dueAt.getTime();
}
