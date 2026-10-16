import {
  addDaysToKey,
  hmToMinutes,
  isValidHm,
  isoWeekdayOfKey,
  zonedMinutesToUtc,
  zonedParts,
} from '@shared/utils/timezone';
import {
  BREAK_KINDS,
  BREAK_LABEL,
  BREAK_PRESENCE_TYPE,
  BreakSlot,
  BreakTiming,
  ShiftDefinition,
  ShiftRules,
  breakAllowsSkip,
} from './shift.types';

/**
 * The break rules, as pure functions of a shift definition and a clock.
 *
 * Vocabulary (one break, e.g. Morning due 11:00 for 15 min, window -30/+60,
 * ring 1 min before for 5 min):
 *   window   10:30 - 12:00   when the break may be started at all
 *   ring     10:59 - 11:04   the agent rings; starting now is ON_TIME
 *   early    10:30 - 10:59   inside the window, before the ring
 *   late     11:04 - 12:00   inside the window, after the ring
 * Outside the window the break cannot be started (it is "missed"/skipped).
 */

export const LIMITS = {
  nameMax: 60,
  durationMin: { min: 1, max: 240 },
  windowBeforeMin: { min: 0, max: 240 },
  windowAfterMin: { min: 0, max: 480 },
  ringLeadMin: { min: 0, max: 30 },
  ringDurationMin: { min: 1, max: 30 },
  reasonMinChars: { min: 1, max: 200 },
  overrunGraceMin: { min: 0, max: 60 },
} as const;

/** Reason text is capped server-side; the agent caps it too. */
export const REASON_MAX_CHARS = 500;

interface ShiftClock {
  startMin: number;
  /** End in minutes after the shift-day's midnight (> startMin; +1440 overnight). */
  endMin: number;
  overnight: boolean;
}

function clockOf(def: Pick<ShiftDefinition, 'start' | 'end'>): ShiftClock {
  const startMin = hmToMinutes(def.start);
  let endMin = hmToMinutes(def.end);
  const overnight = endMin <= startMin;
  if (overnight) endMin += 1440;
  return { startMin, endMin, overnight };
}

/** A clock time of the shift, in minutes after the shift-day's midnight. */
function shiftMinutes(clock: ShiftClock, hm: string): number {
  const m = hmToMinutes(hm);
  return clock.overnight && m < clock.startMin ? m + 1440 : m;
}

/**
 * Validates a shift definition. Returns human-readable problems (empty = valid).
 * The same rules the admin screen shows live.
 */
export function validateShiftDefinition(def: ShiftDefinition): string[] {
  const errors: string[] = [];
  const name = (def.name ?? '').trim();
  if (!name) errors.push('Give the shift a name.');
  if (name.length > LIMITS.nameMax)
    errors.push(`Shift name is longer than ${LIMITS.nameMax} characters.`);
  if (!isValidHm(def.start) || !isValidHm(def.end)) {
    errors.push('Shift start and end must be times like 09:30.');
    return errors;
  }
  if (def.start === def.end) errors.push('Shift start and end cannot be the same time.');

  const days = def.workDays ?? [];
  if (!days.length) errors.push('Pick at least one working day.');
  if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
    errors.push('Working days must be 1 (Monday) to 7 (Sunday).');
  }
  if (new Set(days).size !== days.length) errors.push('Working days are listed twice.');

  const range = (label: string, v: number, lim: { min: number; max: number }) => {
    if (!Number.isInteger(v) || v < lim.min || v > lim.max) {
      errors.push(`${label} must be a whole number from ${lim.min} to ${lim.max}.`);
    }
  };
  range('Ring lead (minutes before)', def.ringLeadMin, LIMITS.ringLeadMin);
  range('Ring length (minutes)', def.ringDurationMin, LIMITS.ringDurationMin);
  range('Minimum reason length', def.reasonMinChars, LIMITS.reasonMinChars);
  range('Overrun grace (minutes)', def.overrunGraceMin, LIMITS.overrunGraceMin);

  const kinds = def.breaks.map((b) => b.kind);
  if (new Set(kinds).size !== kinds.length)
    errors.push('Each break (morning, lunch, evening) can appear once.');
  if (kinds.some((k) => !BREAK_KINDS.includes(k))) errors.push('Unknown break type.');

  const clock = clockOf(def);
  const enabled = BREAK_KINDS.map((k) => def.breaks.find((b) => b.kind === k && b.enabled)).filter(
    (b): b is NonNullable<typeof b> => !!b,
  );

  for (const b of enabled) {
    const label = BREAK_LABEL[b.kind];
    if (!isValidHm(b.startTime)) {
      errors.push(`${label}: start must be a time like 11:00.`);
      continue;
    }
    range(`${label} length`, b.durationMin, LIMITS.durationMin);
    range(`${label} window before`, b.windowBeforeMin, LIMITS.windowBeforeMin);
    range(`${label} window after`, b.windowAfterMin, LIMITS.windowAfterMin);
    const s = shiftMinutes(clock, b.startTime);
    if (s < clock.startMin || s + b.durationMin > clock.endMin) {
      errors.push(`${label} (${b.startTime}) must sit inside the shift hours.`);
    }
    if (def.ringLeadMin > b.windowBeforeMin) {
      errors.push(
        `${label}: the ring would start before the window opens. Widen the window or ring later.`,
      );
    }
    if (b.windowAfterMin < def.ringDurationMin - def.ringLeadMin) {
      errors.push(
        `${label}: the window closes while the agent is still ringing. Widen the window.`,
      );
    }
  }

  for (let i = 1; i < enabled.length; i++) {
    const a = enabled[i - 1];
    const z = enabled[i];
    if (!isValidHm(a.startTime) || !isValidHm(z.startTime)) continue;
    const aStart = shiftMinutes(clock, a.startTime);
    const zStart = shiftMinutes(clock, z.startTime);
    if (zStart <= aStart) {
      errors.push('Breaks must run in order: morning, then lunch, then evening.');
      continue;
    }
    const aClose = aStart + a.windowAfterMin;
    const zOpen = zStart - z.windowBeforeMin;
    if (aClose > zOpen) {
      errors.push(
        `${BREAK_LABEL[a.kind]} window overlaps the ${BREAK_LABEL[z.kind].toLowerCase()} window. ` +
          'Windows cannot overlap: that is what stops an earlier break being taken after a later one.',
      );
    }
  }
  return errors;
}

/**
 * Which shift-day `now` belongs to. For a day shift that is simply today. For a
 * shift that runs past midnight, the early-morning hours (before the shift's end)
 * still belong to the previous evening's shift.
 */
export function shiftDayKey(
  def: Pick<ShiftDefinition, 'start' | 'end'>,
  now: Date,
  tz: string,
): string {
  const p = zonedParts(now, tz);
  const today = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  const clock = clockOf(def);
  if (!clock.overnight) return today;
  const nowMin = p.hour * 60 + p.minute;
  return nowMin < clock.endMin - 1440 ? addDaysToKey(today, -1) : today;
}

/** Whether `dateKey` is one of the shift's working days. */
export function isWorkDay(def: Pick<ShiftDefinition, 'workDays'>, dateKey: string): boolean {
  return (def.workDays ?? []).includes(isoWeekdayOfKey(dateKey));
}

/** Absolute start/end of the shift on a shift-day. */
export function shiftBounds(
  def: Pick<ShiftDefinition, 'start' | 'end'>,
  dateKey: string,
  tz: string,
): { start: Date; end: Date } {
  const clock = clockOf(def);
  return {
    start: zonedMinutesToUtc(dateKey, clock.startMin, tz),
    end: zonedMinutesToUtc(dateKey, clock.endMin, tz),
  };
}

/** The enabled breaks of a shift on a shift-day, as absolute instants, in order. */
export function breakSlots(def: ShiftDefinition, dateKey: string, tz: string): BreakSlot[] {
  if (!isValidHm(def.start) || !isValidHm(def.end)) return [];
  const clock = clockOf(def);
  const slots: BreakSlot[] = [];
  for (const kind of BREAK_KINDS) {
    const b = def.breaks.find((x) => x.kind === kind && x.enabled);
    if (!b || !isValidHm(b.startTime)) continue;
    const startMin = shiftMinutes(clock, b.startTime);
    const at = (min: number) => zonedMinutesToUtc(dateKey, min, tz);
    slots.push({
      kind,
      label: BREAK_LABEL[kind],
      presenceType: BREAK_PRESENCE_TYPE[kind],
      durationMin: b.durationMin,
      scheduledStart: at(startMin),
      scheduledEnd: at(startMin + b.durationMin),
      windowOpen: at(startMin - b.windowBeforeMin),
      windowClose: at(startMin + b.windowAfterMin),
      ringStart: at(startMin - def.ringLeadMin),
      ringEnd: at(startMin - def.ringLeadMin + def.ringDurationMin),
      allowSkip: breakAllowsSkip(b),
    });
  }
  return slots;
}

export type SlotPhase = 'UPCOMING' | 'EARLY' | 'DUE' | 'LATE' | 'CLOSED';

/** Where `now` falls relative to a slot (ignoring whether it was taken). */
export function phaseAt(slot: BreakSlot, now: Date): SlotPhase {
  const t = now.getTime();
  if (t < slot.windowOpen.getTime()) return 'UPCOMING';
  if (t >= slot.windowClose.getTime()) return 'CLOSED';
  if (t < slot.ringStart.getTime()) return 'EARLY';
  if (t < slot.ringEnd.getTime()) return 'DUE';
  return 'LATE';
}

export interface StartClassification {
  timing: BreakTiming;
  /** Whole minutes before (EARLY) or after (LATE) the scheduled start. */
  minutesOff: number;
  reasonRequired: boolean;
}

/**
 * How a start at `now` is judged. Starting while the agent rings is on time;
 * earlier or later inside the window needs a reason when the shift says so.
 */
export function classifyStart(slot: BreakSlot, now: Date, rules: ShiftRules): StartClassification {
  const phase = phaseAt(slot, now);
  const deltaMin = (now.getTime() - slot.scheduledStart.getTime()) / 60_000;
  switch (phase) {
    case 'DUE':
      return { timing: 'ON_TIME', minutesOff: 0, reasonRequired: false };
    case 'EARLY':
      return {
        timing: 'EARLY',
        minutesOff: Math.max(1, Math.ceil(-deltaMin)),
        reasonRequired: rules.reasonOnEarly,
      };
    case 'LATE':
      return {
        timing: 'LATE',
        minutesOff: Math.max(1, Math.floor(deltaMin)),
        reasonRequired: rules.reasonOnLate,
      };
    default:
      return {
        timing: 'OUTSIDE_WINDOW',
        minutesOff: Math.max(0, Math.round(Math.abs(deltaMin))),
        reasonRequired: false,
      };
  }
}

/** Seconds a finished break ran past its length (0 when within it). */
export function overrunSeconds(
  durationMin: number | null,
  startedAt: Date,
  endedAt: Date | null,
  now: Date,
): number {
  if (!durationMin) return 0;
  const end = (endedAt ?? now).getTime();
  const took = Math.max(0, Math.round((end - startedAt.getTime()) / 1000));
  return Math.max(0, took - durationMin * 60);
}
