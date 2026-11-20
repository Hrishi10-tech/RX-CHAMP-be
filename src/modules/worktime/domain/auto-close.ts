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

/**
 * Forgotten End Day (Fix 11). Once the shift has ended (no shift: 9 hours after the
 * start), a day with no keyboard or mouse input for `idleMin` minutes is ended, and
 * it ends at that last input: last input 19:30 with 30 minutes configured closes
 * at 20:00, dated 19:30. Input keeps the day open (overtime is never cut), until
 * the hard stop `latestEnd`.
 */
export const NO_SHIFT_IDLE_RULE_FROM_MS = 9 * 60 * 60_000;

export function idleRuleFrom(input: { startedAt: Date; shiftEnd: Date | null }): Date {
  return input.shiftEnd ?? new Date(input.startedAt.getTime() + NO_SHIFT_IDLE_RULE_FROM_MS);
}

/** When the idle rule ends the day: idleMin after the last input, never before the shift end. */
export function idleCloseDue(input: {
  startedAt: Date;
  shiftEnd: Date | null;
  lastInput: Date | null;
  idleMin: number;
}): Date {
  const quietSince = (input.lastInput ?? input.startedAt).getTime();
  const due = quietSince + input.idleMin * 60_000;
  return new Date(Math.max(due, idleRuleFrom(input).getTime()));
}

/**
 * The real last input from the samples around it: the agent only flags idle once
 * its threshold has passed, so when an idle (not locked) sample follows the last
 * active one, the input stopped one threshold before that flag; a lock is the
 * instant work stopped; with nothing after, the last active sample's own span.
 */
export function realLastInput(input: {
  lastActiveAt: Date | null;
  lastActiveSec: number;
  nextIdleAt: Date | null;
  nextIdleLocked: boolean;
  idleThresholdSec: number;
  now: Date;
}): Date | null {
  if (!input.lastActiveAt) return null;
  const at = input.lastActiveAt.getTime();
  const own = at + Math.max(0, Math.min(input.lastActiveSec, 150)) * 1000;
  let end = Math.min(own, input.now.getTime());
  if (input.nextIdleAt) {
    const flag = input.nextIdleAt.getTime();
    end = Math.min(end, input.nextIdleLocked ? flag : flag - input.idleThresholdSec * 1000);
  }
  // An active sample means input within one threshold before it.
  return new Date(Math.max(end, at - input.idleThresholdSec * 1000));
}

export function latestEndOf(input: {
  startedAt: Date;
  /** End of the person's shift on the session date; null for no shift or a day off. */
  shiftEnd: Date | null;
  autoCloseAfterShiftEndMin: number;
  /**
   * 4.1 shared computer: when the person chose to carry on into the next shift. The
   * day then runs until End Day, closed automatically only after a no-shift day's
   * length from that answer (a forgotten computer still closes).
   */
  extendedAt?: Date | null;
}): Date {
  const afterMs = input.autoCloseAfterShiftEndMin * 60_000;
  const start = input.startedAt.getTime();
  const rule = input.shiftEnd ? input.shiftEnd.getTime() + afterMs : start + NO_SHIFT_SESSION_MS;
  const extended = input.extendedAt ? input.extendedAt.getTime() + NO_SHIFT_SESSION_MS : 0;
  return new Date(Math.max(rule, start + afterMs, extended));
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
