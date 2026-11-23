import { addDaysToKey, isValidDateKey, zonedMinutesToUtc } from '@shared/utils/timezone';

/**
 * Biometric punches (3.5), as pure functions: codes, times, directions, and how a
 * day is worked out from its punches. No Nest, no Prisma.
 */

export const PUNCH_SOURCES = ['PUSH', 'PULL', 'CSV', 'MANUAL'] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];
export type PunchDirection = 'IN' | 'OUT';

export const CODE_MAX = 64;
export const DEVICE_MAX = 64;
export const EXTERNAL_ID_MAX = 128;
/** A punch more than this far ahead of the server clock is refused (device clocks drift). */
export const FUTURE_SLACK_MS = 10 * 60_000;
/** Older punches are refused: nothing that old can change a day any more. */
export const MAX_AGE_DAYS = 400;
/** A punch this close after an open day's first punch belongs to that day (staying past midnight). */
export const OPEN_DAY_REACH_MS = 16 * 3_600_000;

/**
 * The code as a person is matched by: trimmed, upper case, inner spaces removed;
 * an all-digit code loses its leading zeros (devices write 42, 042 and 0042 alike).
 * Null when nothing is left.
 */
export function normalizeCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const text = (typeof raw === 'number' ? String(Math.trunc(raw)) : String(raw))
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
  if (!text.length || text.length > CODE_MAX) return null;
  if (/^\d+$/.test(text)) return text.replace(/^0+(?=\d)/, '');
  return text;
}

// Numbers are left to the integration's own mapping: devices disagree on them
// (ZKTeco BioTime writes 0 for a check-in, others write 1).
const IN_WORDS = new Set(['IN', 'I', 'CHECKIN', 'CHECK-IN', 'CHECK_IN', 'ENTRY', 'ENTER', 'C/IN']);
const OUT_WORDS = new Set(['OUT', 'O', 'CHECKOUT', 'CHECK-OUT', 'CHECK_OUT', 'EXIT', 'C/OUT']);

/**
 * A direction as devices write it; null when unknown or not given. `extraIn` and
 * `extraOut` are the integration's own words (a pull adapter's mapping).
 */
export function normalizeDirection(
  raw: unknown,
  extra: { inWords?: readonly string[]; outWords?: readonly string[] } = {},
): PunchDirection | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const text = String(raw).trim().toUpperCase();
  if (extra.inWords?.some((w) => w.toUpperCase() === text)) return 'IN';
  if (extra.outWords?.some((w) => w.toUpperCase() === text)) return 'OUT';
  if (IN_WORDS.has(text)) return 'IN';
  if (OUT_WORDS.has(text)) return 'OUT';
  return null;
}

const LOCAL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A punch time: ISO 8601 with an offset ("2026-11-04T09:02:11+05:30", "...Z"), a
 * local time in the business time zone ("2026-11-04 09:02:11"), or epoch seconds
 * or milliseconds. Null when unreadable.
 */
export function parsePunchTime(raw: unknown, tz: string): Date | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Below 10^11 it is seconds (until the year 5138); above, milliseconds.
    const ms = raw < 1e11 ? raw * 1000 : raw;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (/^\d{9,13}$/.test(text)) return parsePunchTime(Number(text), tz);
  if (ZONED.test(text)) {
    const d = new Date(text);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = LOCAL.exec(text);
  if (m) {
    const [, date, h, mi, sec] = m;
    if (!isValidDateKey(date)) return null;
    const hours = Number(h);
    const minutes = Number(mi);
    if (hours > 23 || minutes > 59) return null;
    const base = zonedMinutesToUtc(date, hours * 60 + minutes, tz);
    return new Date(base.getTime() + Number(sec ?? 0) * 1000);
  }
  return null;
}

export interface PunchInput {
  code: unknown;
  time: unknown;
  direction?: unknown;
  deviceId?: unknown;
  externalId?: unknown;
}

export interface CleanPunch {
  code: string;
  codeKey: string;
  punchedAt: Date;
  direction: PunchDirection | null;
  deviceId: string;
  externalId: string | null;
}

/** One punch checked; `why` says what is wrong with it. */
export function cleanPunch(
  input: PunchInput,
  ctx: { now: Date; tz: string; inWords?: readonly string[]; outWords?: readonly string[] },
): { ok: true; value: CleanPunch } | { ok: false; why: string } {
  const codeKey = normalizeCode(input.code);
  if (!codeKey) return { ok: false, why: `code is missing or longer than ${CODE_MAX} characters` };
  const punchedAt = parsePunchTime(input.time, ctx.tz);
  if (!punchedAt) return { ok: false, why: 'time is not a readable date and time' };
  if (punchedAt.getTime() > ctx.now.getTime() + FUTURE_SLACK_MS) {
    return { ok: false, why: 'time is in the future (check the device clock)' };
  }
  if (punchedAt.getTime() < ctx.now.getTime() - MAX_AGE_DAYS * 86_400_000) {
    return { ok: false, why: `time is more than ${MAX_AGE_DAYS} days ago` };
  }
  const deviceId =
    input.deviceId === undefined || input.deviceId === null ? '' : String(input.deviceId).trim();
  if (deviceId.length > DEVICE_MAX) {
    return { ok: false, why: `deviceId is longer than ${DEVICE_MAX} characters` };
  }
  const ext =
    input.externalId === undefined || input.externalId === null
      ? null
      : String(input.externalId).trim();
  if (ext && ext.length > EXTERNAL_ID_MAX) {
    return { ok: false, why: `externalId is longer than ${EXTERNAL_ID_MAX} characters` };
  }
  const raw = input.code === null || input.code === undefined ? '' : String(input.code).trim();
  return {
    ok: true,
    value: {
      code: raw.slice(0, CODE_MAX),
      codeKey,
      // Whole seconds: a device that sends milliseconds and one that does not agree.
      punchedAt: new Date(Math.floor(punchedAt.getTime() / 1000) * 1000),
      direction: normalizeDirection(input.direction, ctx),
      deviceId,
      externalId: ext || null,
    },
  };
}

// ---- The day from its punches --------------------------------------------------------

export const GAP_RULES = ['SPAN', 'PAIRS'] as const;
export type GapRule = (typeof GAP_RULES)[number];
export const MISSING_CHECKOUT_RULES = ['LAST_PUNCH', 'SHIFT_END'] as const;
export type MissingCheckoutRule = (typeof MISSING_CHECKOUT_RULES)[number];

export interface DayPunchLite {
  at: Date;
  direction: PunchDirection | null;
}

export interface PlannedSession {
  startedAt: Date;
  endedAt: Date | null;
  endReason: 'USER' | 'AUTO_CLOSED' | null;
}

export interface DayPlan {
  sessions: PlannedSession[];
  /** The day is still running (a check-in with no check-out after it yet). */
  open: boolean;
  /** Closed at the cutoff with no check-out. */
  checkoutMissing: boolean;
  /** The first punch was a check-out (nobody checked in). */
  checkinMissing: boolean;
  /** Punches used after dropping near-duplicates. */
  used: DayPunchLite[];
}

export interface PlanOptions {
  gapRule: GapRule;
  missingCheckout: MissingCheckoutRule;
  /** Punches this close to the one before (same or unknown direction) are one punch. */
  duplicateWindowSec: number;
  /** The day closes by itself after this instant (shift end + the automatic close setting). */
  cutoff: Date;
  /** End of the shift that day, for SHIFT_END; null with no shift. */
  shiftEnd: Date | null;
  now: Date;
}

/** Punches in time order with near-duplicates dropped (a finger held on the reader). */
export function dedupePunches(list: readonly DayPunchLite[], windowSec: number): DayPunchLite[] {
  const sorted = [...list].sort((a, b) => a.at.getTime() - b.at.getTime());
  const out: DayPunchLite[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    const close = last && p.at.getTime() - last.at.getTime() <= windowSec * 1000;
    const sameWay = last && (!p.direction || !last.direction || p.direction === last.direction);
    if (close && sameWay) continue;
    out.push(p);
  }
  return out;
}

/**
 * The work sessions a day's punches make. SPAN: first punch to last punch, the
 * time between counted in full (the rule as asked). PAIRS: each check-in to the
 * next check-out, gaps left out; punches with no direction alternate in, out, in.
 * A day still open after `cutoff` closes at its last punch (or the shift end).
 */
export function planBiometricDay(punches: readonly DayPunchLite[], o: PlanOptions): DayPlan {
  const used = dedupePunches(punches, o.duplicateWindowSec);
  const none: DayPlan = {
    sessions: [],
    open: false,
    checkoutMissing: false,
    checkinMissing: false,
    used,
  };
  if (!used.length) return none;
  const past = o.now.getTime() > o.cutoff.getTime();
  const closeOpen = (start: Date, lastPunch: Date): PlannedSession => {
    const end =
      o.missingCheckout === 'SHIFT_END' && o.shiftEnd && o.shiftEnd.getTime() > lastPunch.getTime()
        ? o.shiftEnd
        : lastPunch;
    return {
      startedAt: start,
      endedAt: end.getTime() < start.getTime() ? start : end,
      endReason: 'AUTO_CLOSED',
    };
  };
  const first = used[0];
  const last = used[used.length - 1];
  const checkinMissing = first.direction === 'OUT';

  if (o.gapRule === 'SPAN') {
    const known = used.some((p) => p.direction);
    const open = known ? last.direction !== 'OUT' : used.length % 2 === 1;
    if (!open) {
      return {
        sessions: [{ startedAt: first.at, endedAt: last.at, endReason: 'USER' }],
        open: false,
        checkoutMissing: false,
        checkinMissing,
        used,
      };
    }
    if (!past) {
      return {
        sessions: [{ startedAt: first.at, endedAt: null, endReason: null }],
        open: true,
        checkoutMissing: false,
        checkinMissing,
        used,
      };
    }
    return {
      sessions: [closeOpen(first.at, last.at)],
      open: false,
      checkoutMissing: true,
      checkinMissing,
      used,
    };
  }

  // PAIRS
  const sessions: PlannedSession[] = [];
  let openFrom: Date | null = null;
  for (const p of used) {
    const dir = p.direction ?? (openFrom ? 'OUT' : 'IN');
    if (dir === 'IN') {
      if (!openFrom) openFrom = p.at;
      continue;
    }
    if (openFrom) {
      sessions.push({ startedAt: openFrom, endedAt: p.at, endReason: 'USER' });
      openFrom = null;
    } else if (sessions.length) {
      // A second check-out: the later one counts.
      sessions[sessions.length - 1].endedAt = p.at;
    } else {
      sessions.push({ startedAt: p.at, endedAt: p.at, endReason: 'USER' });
    }
  }
  if (openFrom) {
    if (!past) {
      sessions.push({ startedAt: openFrom, endedAt: null, endReason: null });
      return { sessions, open: true, checkoutMissing: false, checkinMissing, used };
    }
    sessions.push(closeOpen(openFrom, openFrom));
    return { sessions, open: false, checkoutMissing: true, checkinMissing, used };
  }
  return { sessions, open: false, checkoutMissing: false, checkinMissing, used };
}

/**
 * The working day a punch belongs to. Its shift-day, except when that day has no
 * punch yet and the day before is still open and began within 16 hours: then the
 * punch closes the day before (someone working past midnight).
 */
export function dayKeyForPunch(input: {
  at: Date;
  /** The person's shift-day of the punch. */
  shiftDay: string;
  /** Whether the shift-day already holds another punch. */
  shiftDayHasPunches: boolean;
  /** The day before the shift-day: open or not, and its first punch. */
  previous: { open: boolean; firstAt: Date | null } | null;
}): string {
  const prev = input.previous;
  if (
    !input.shiftDayHasPunches &&
    prev?.open &&
    prev.firstAt &&
    input.at.getTime() > prev.firstAt.getTime() &&
    input.at.getTime() - prev.firstAt.getTime() <= OPEN_DAY_REACH_MS
  ) {
    return addDaysToKey(input.shiftDay, -1);
  }
  return input.shiftDay;
}
