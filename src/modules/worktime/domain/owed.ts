/**
 * Auto-skip (SPEC 1.4), as pure functions.
 *
 * A scheduled break is OWED when one of the person's work sessions covers its
 * scheduled start (an open session counts up to now). An owed break with no
 * record when its window closes becomes AUTO_SKIPPED at the window close. When
 * the person ends the day while an owed break's window is still open, it becomes
 * AUTO_SKIPPED at that moment.
 */

export interface OwedSlot<K extends string = string> {
  kind: K;
  scheduledStart: Date;
  windowOpen: Date;
  windowClose: Date;
}

export interface SessionSpan {
  startedAt: Date;
  endedAt: Date | null;
}

export interface AutoSkipPlan<K extends string = string> {
  kind: K;
  /** The record's startedAt: the window close, or now at End Day. */
  startedAt: Date;
  /** True when made at End Day inside the still-open window. */
  atEndDay: boolean;
}

/** Whether a session covers the slot's scheduled start (inclusive at both ends). */
export function isOwed(
  slot: Pick<OwedSlot, 'scheduledStart'>,
  sessions: SessionSpan[],
  now: Date,
): boolean {
  const t = slot.scheduledStart.getTime();
  return sessions.some((s) => {
    const end = (s.endedAt ?? now).getTime();
    return s.startedAt.getTime() <= t && t <= end;
  });
}

/**
 * Which slots must become AUTO_SKIPPED now.
 *
 * @param recorded kinds that already have a record today (taken or skipped)
 * @param endingDay true while End Day runs: open windows of owed breaks count too
 */
export function planAutoSkips<K extends string>(
  slots: OwedSlot<K>[],
  recorded: ReadonlySet<K>,
  sessions: SessionSpan[],
  now: Date,
  endingDay: boolean,
): AutoSkipPlan<K>[] {
  const out: AutoSkipPlan<K>[] = [];
  const t = now.getTime();
  for (const slot of slots) {
    if (recorded.has(slot.kind)) continue;
    if (!isOwed(slot, sessions, now)) continue;
    if (t >= slot.windowClose.getTime()) {
      out.push({ kind: slot.kind, startedAt: slot.windowClose, atEndDay: false });
    } else if (endingDay && t >= slot.windowOpen.getTime()) {
      out.push({ kind: slot.kind, startedAt: now, atEndDay: true });
    }
  }
  return out;
}
