/**
 * Leave (3.4): two pools, counted in quarter days.
 *
 * CL/SL (casual or sick leave) lapses at the end of the year; EL/PL (earned or
 * privilege leave) carries over. Both allow a full day (or a range of full days),
 * a half day and a quarter day. Comp off (3.5) is a third leave type with no
 * yearly pool: it is taken against credits earned by working extra days. Pure: no
 * Nest, no Prisma.
 */

export const LEAVE_CATEGORIES = ['CLSL', 'ELPL', 'COMPOFF'] as const;
export type LeaveCategory = (typeof LEAVE_CATEGORIES)[number];

/** The two yearly pools: accounts, quotas, adjustments and carry-over are theirs alone. */
export const POOL_CATEGORIES = ['CLSL', 'ELPL'] as const;
export type PoolCategory = (typeof POOL_CATEGORIES)[number];

export const LEAVE_KINDS = ['FULL_DAY', 'HALF_DAY', 'QUARTER_DAY'] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_PARTS = ['FIRST_HALF', 'SECOND_HALF', 'Q1', 'Q2', 'Q3', 'Q4'] as const;
export type LeavePart = (typeof LEAVE_PARTS)[number];

export const LEAVE_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'REVOKED'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

/** Requests that hold days: a pending one reserves them, an approved one has taken them. */
export const ACTIVE_STATUSES: readonly LeaveStatus[] = ['PENDING', 'APPROVED'];

export const CATEGORY_LABEL: Record<LeaveCategory, string> = {
  CLSL: 'CL/SL',
  ELPL: 'EL/PL',
  COMPOFF: 'Comp off',
};
export const CATEGORY_NAME: Record<LeaveCategory, string> = {
  CLSL: 'Casual or sick leave',
  ELPL: 'Earned or privilege leave',
  COMPOFF: 'Compensatory off, for extra days worked',
};
export const KIND_LABEL: Record<LeaveKind, string> = {
  FULL_DAY: 'Full day',
  HALF_DAY: 'Half day',
  QUARTER_DAY: 'Quarter day',
};
export const PART_LABEL: Record<LeavePart, string> = {
  FIRST_HALF: 'first half',
  SECOND_HALF: 'second half',
  Q1: '1st quarter',
  Q2: '2nd quarter',
  Q3: '3rd quarter',
  Q4: '4th quarter',
};
export const STATUS_LABEL: Record<LeaveStatus, string> = {
  PENDING: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
  REVOKED: 'Revoked',
};

/** A day is four quarters; every amount is a whole number of them. */
export const UNITS_PER_DAY = 4;

/** Quarters of a day as bits: Q1 = 1, Q2 = 2, Q3 = 4, Q4 = 8. */
export const FULL_MASK = 0b1111;
export const PART_MASK: Record<LeavePart, number> = {
  FIRST_HALF: 0b0011,
  SECOND_HALF: 0b1100,
  Q1: 0b0001,
  Q2: 0b0010,
  Q3: 0b0100,
  Q4: 0b1000,
};

/** Which parts each kind takes (a full day takes none). */
export const KIND_PARTS: Record<LeaveKind, readonly LeavePart[]> = {
  FULL_DAY: [],
  HALF_DAY: ['FIRST_HALF', 'SECOND_HALF'],
  QUARTER_DAY: ['Q1', 'Q2', 'Q3', 'Q4'],
};

export function isCategory(v: unknown): v is LeaveCategory {
  return typeof v === 'string' && (LEAVE_CATEGORIES as readonly string[]).includes(v);
}
export function isPool(v: unknown): v is PoolCategory {
  return typeof v === 'string' && (POOL_CATEGORIES as readonly string[]).includes(v);
}
export function isKind(v: unknown): v is LeaveKind {
  return typeof v === 'string' && (LEAVE_KINDS as readonly string[]).includes(v);
}
export function isPart(v: unknown): v is LeavePart {
  return typeof v === 'string' && (LEAVE_PARTS as readonly string[]).includes(v);
}
export function isStatus(v: unknown): v is LeaveStatus {
  return typeof v === 'string' && (LEAVE_STATUSES as readonly string[]).includes(v);
}

/** The quarters one day of a request covers. */
export function maskOf(kind: LeaveKind, part: LeavePart | null): number {
  if (kind === 'FULL_DAY' || !part) return FULL_MASK;
  return PART_MASK[part];
}

/** Quarters set in a mask. */
export function unitsOfMask(mask: number): number {
  let n = 0;
  for (let m = mask & FULL_MASK; m; m >>= 1) n += m & 1;
  return n;
}

/** Quarters of leave at the start of the day (Q1, Q1+Q2, ...): they move the late-start mark. */
export function leadingQuarters(mask: number): number {
  let n = 0;
  while (n < UNITS_PER_DAY && mask & (1 << n)) n += 1;
  return n;
}

/** Quarters of leave at the end of the day (Q4, Q3+Q4, ...). */
export function trailingQuarters(mask: number): number {
  let n = 0;
  while (n < UNITS_PER_DAY && mask & (1 << (UNITS_PER_DAY - 1 - n))) n += 1;
  return n;
}

/** 6 -> 1.5 */
export function daysOf(units: number): number {
  return units / UNITS_PER_DAY;
}

/** 1.5 -> 6; null when not a whole number of quarter days. */
export function unitsOfDays(days: unknown): number | null {
  if (typeof days !== 'number' || !Number.isFinite(days)) return null;
  const units = Math.round(days * UNITS_PER_DAY);
  return Math.abs(units - days * UNITS_PER_DAY) < 1e-9 ? units : null;
}

/** "1 day", "0.5 day", "2.25 days", "−1.5 days" (signed: "+2 days"). */
export function formatDays(units: number, opts: { signed?: boolean } = {}): string {
  const days = daysOf(units);
  const abs = Math.abs(days);
  const n = Number.isInteger(abs) ? String(abs) : String(Number(abs.toFixed(2)));
  const word = abs !== 0 && abs <= 1 ? 'day' : 'days';
  const sign = days < 0 ? '−' : opts.signed && days > 0 ? '+' : '';
  return `${sign}${n} ${word}`;
}

/** "Full day", "Half day (first half)", "Quarter day (3rd quarter)". */
export function kindLabel(kind: LeaveKind, part: LeavePart | null): string {
  if (kind === 'FULL_DAY' || !part) return KIND_LABEL.FULL_DAY;
  return `${KIND_LABEL[kind]} (${PART_LABEL[part]})`;
}
