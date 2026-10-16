/**
 * Missed End Day (SPEC 1.2), as pure functions.
 *
 *   latestEnd = end of the shift on the session's date + autoCloseAfterShiftEndMin
 *               (no shift, or a day off: startedAt + 14h)
 *   stale     = now > latestEnd
 *   closed at = the last non-idle input inside the session, clamped to
 *               [startedAt, latestEnd]; startedAt when there was none.
 *
 * One addition the spec leaves open: latestEnd is never earlier than startedAt +
 * autoCloseAfterShiftEndMin. Without it, a session resumed after the shift's
 * latest end would be stale the moment it opened and closed at zero length.
 */

export const NO_SHIFT_SESSION_MS = 14 * 60 * 60_000;

export function latestEndOf(input: {
  startedAt: Date;
  /** End of the person's shift on the session date; null for no shift or a day off. */
  shiftEnd: Date | null;
  autoCloseAfterShiftEndMin: number;
}): Date {
  const afterMs = input.autoCloseAfterShiftEndMin * 60_000;
  const start = input.startedAt.getTime();
  const rule = input.shiftEnd ? input.shiftEnd.getTime() + afterMs : start + NO_SHIFT_SESSION_MS;
  return new Date(Math.max(rule, start + afterMs));
}

export function isStale(latestEnd: Date, now: Date): boolean {
  return now.getTime() > latestEnd.getTime();
}

export function autoCloseAt(input: {
  startedAt: Date;
  latestEnd: Date;
  lastInput: Date | null;
}): Date {
  const start = input.startedAt.getTime();
  if (!input.lastInput) return new Date(start);
  const clamped = Math.min(Math.max(input.lastInput.getTime(), start), input.latestEnd.getTime());
  return new Date(clamped);
}
