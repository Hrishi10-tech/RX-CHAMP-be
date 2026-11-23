import { addDaysToKey } from '@shared/utils/timezone';
import { DeciderRole } from './routing';
import { formatDays, LeaveStatus, UNITS_PER_DAY } from './leave.types';

/**
 * Comp off (3.5), as pure functions.
 *
 * A credit is earned for an extra day worked (a weekly off, a holiday, or a full
 * day of approved leave): a full day at `fullPct` of the shift's expected time, a
 * half day at `halfPct`. A claim is approved by the person's approver; a Manager,
 * the Super Manager or a Super Admin can also credit comp off by hand. An approved
 * credit can be taken as leave of type COMPOFF on any day up to its expiry
 * (`validityDays` after the day worked).
 *
 * Leave days taken are charged against credits valid on the day taken, the one
 * that lapses first first. Credits are never split by hand: who drew on which is
 * worked out again from all of them every time (greedy by date, earliest expiry
 * first, which finds a fit whenever one exists). Counted in quarter days.
 */

export const COMPOFF_DAY_KINDS = ['WEEKLY_OFF', 'HOLIDAY', 'LEAVE', 'WORKING'] as const;
export type CompOffDayKind = (typeof COMPOFF_DAY_KINDS)[number];

export const COMPOFF_DAY_KIND_LABEL: Record<CompOffDayKind, string> = {
  WEEKLY_OFF: 'Weekly day off',
  HOLIDAY: 'Holiday',
  LEAVE: 'On leave',
  WORKING: 'Working day',
};

export type CompOffSource = 'CLAIM' | 'GRANT';

export interface CompOffCreditRecord {
  id: string;
  userId: string;
  workedDate: string;
  dayKind: CompOffDayKind;
  dayLabel: string;
  workedSec: number;
  askedUnits: number;
  /** Given once approved (0 before). */
  units: number;
  reason: string;
  source: CompOffSource;
  status: LeaveStatus;
  approverRole: DeciderRole | null;
  approverId: string | null;
  decidedById: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresOn: string | null;
  expiryNoticeAt: Date | null;
  createdById: string;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type NewCompOffCredit = Omit<
  CompOffCreditRecord,
  'id' | 'createdAt' | 'updatedAt' | 'expiryNoticeAt' | 'cancelledAt'
>;

export type CompOffCreditPatch = Partial<
  Pick<
    CompOffCreditRecord,
    | 'status'
    | 'units'
    | 'decidedById'
    | 'decidedAt'
    | 'decisionNote'
    | 'expiresOn'
    | 'expiryNoticeAt'
    | 'cancelledAt'
  >
>;

/** One charged day of an active COMPOFF leave request. */
export interface CompOffUse {
  requestId: string;
  date: string;
  units: number;
  status: 'PENDING' | 'APPROVED';
  /** Earlier requests draw first on the same day (createdAt in ms). */
  order: number;
}

/** An approved credit as the allocation sees it. */
export interface CreditLot {
  id: string;
  workedDate: string;
  expiresOn: string;
  units: number;
}

export interface LotState extends CreditLot {
  /** Drawn by approved leave. */
  usedUnits: number;
  /** Held by leave waiting for approval. */
  heldUnits: number;
  /** Not drawn, and past its expiry. */
  lapsedUnits: number;
  /** Not drawn and still valid today. */
  remainingUnits: number;
}

export interface CompOffAllocation {
  lots: LotState[];
  /** Units of each request no valid credit covers (0 for almost every request). */
  shortByRequest: Map<string, number>;
  shortUnits: number;
  /** Which credit each request day draws on. */
  draws: { requestId: string; date: string; creditId: string; units: number }[];
}

/** Units an extra day earns: 4 (full) at fullPct of the basis, 2 (half) at halfPct, else 0. */
export function earnedUnits(
  workedSec: number,
  basisSec: number,
  fullPct: number,
  halfPct: number,
): 0 | 2 | 4 {
  if (workedSec <= 0 || basisSec <= 0) return 0;
  // Integer comparison, so the boundaries are exact (as attendance does).
  if (workedSec * 100 >= basisSec * fullPct) return 4;
  if (workedSec * 100 >= basisSec * halfPct) return 2;
  return 0;
}

/** Seconds needed for `units` (2 or 4) of comp off. */
export function secondsNeeded(units: number, basisSec: number, fullPct: number, halfPct: number) {
  const pct = units >= UNITS_PER_DAY ? fullPct : halfPct;
  return Math.ceil((basisSec * pct) / 100);
}

/** The last day a credit for `workedDate` can be taken. */
export function expiryOf(workedDate: string, validityDays: number): string {
  return addDaysToKey(workedDate, validityDays);
}

/** Approved credits as lots (anything else does not count). */
export function lotsOf(credits: readonly CompOffCreditRecord[]): CreditLot[] {
  return credits
    .filter((c) => c.status === 'APPROVED' && c.units > 0 && c.expiresOn)
    .map((c) => ({ id: c.id, workedDate: c.workedDate, expiresOn: c.expiresOn!, units: c.units }));
}

/**
 * Who draws on which credit. Uses go in date order (approved before waiting on the
 * same day, then the older request first); each takes from the valid credit that
 * lapses first. `today` decides what has lapsed.
 */
export function allocateCompOff(
  credits: readonly CreditLot[],
  uses: readonly CompOffUse[],
  today: string,
): CompOffAllocation {
  const lots: LotState[] = credits
    .map((c) => ({ ...c, usedUnits: 0, heldUnits: 0, lapsedUnits: 0, remainingUnits: 0 }))
    .sort(
      (a, b) =>
        a.expiresOn.localeCompare(b.expiresOn) ||
        a.workedDate.localeCompare(b.workedDate) ||
        a.id.localeCompare(b.id),
    );
  const left = new Map(lots.map((l) => [l.id, l.units]));
  const ordered = [...uses].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(b.status === 'APPROVED') - Number(a.status === 'APPROVED') ||
      a.order - b.order ||
      a.requestId.localeCompare(b.requestId),
  );
  const shortByRequest = new Map<string, number>();
  const draws: CompOffAllocation['draws'] = [];
  for (const u of ordered) {
    let need = u.units;
    for (const l of lots) {
      if (need <= 0) break;
      if (l.expiresOn < u.date) continue;
      const have = left.get(l.id) ?? 0;
      if (have <= 0) continue;
      const take = Math.min(have, need);
      left.set(l.id, have - take);
      need -= take;
      if (u.status === 'APPROVED') l.usedUnits += take;
      else l.heldUnits += take;
      draws.push({ requestId: u.requestId, date: u.date, creditId: l.id, units: take });
    }
    if (need > 0) shortByRequest.set(u.requestId, (shortByRequest.get(u.requestId) ?? 0) + need);
  }
  for (const l of lots) {
    const rest = left.get(l.id) ?? 0;
    if (l.expiresOn < today) l.lapsedUnits = rest;
    else l.remainingUnits = rest;
  }
  let shortUnits = 0;
  for (const v of shortByRequest.values()) shortUnits += v;
  return { lots, shortByRequest, shortUnits, draws };
}

export interface CompOffBalance {
  /** Approved credits, all time. */
  earnedUnits: number;
  takenUnits: number;
  /** Held by leave waiting for approval. */
  pendingUnits: number;
  lapsedUnits: number;
  /** Can be taken from today. */
  availableUnits: number;
  /** Claims waiting for a decision (days asked for). */
  claimsWaitingUnits: number;
  /** The next credit to lapse with something left on it. */
  nextExpiry: { date: string; units: number } | null;
}

export function compOffBalanceOf(
  alloc: CompOffAllocation,
  credits: readonly CompOffCreditRecord[],
): CompOffBalance {
  let earned = 0;
  let taken = 0;
  let pending = 0;
  let lapsed = 0;
  let available = 0;
  let next: { date: string; units: number } | null = null;
  for (const l of alloc.lots) {
    earned += l.units;
    taken += l.usedUnits;
    pending += l.heldUnits;
    lapsed += l.lapsedUnits;
    available += l.remainingUnits;
    if (l.remainingUnits > 0 && (!next || l.expiresOn < next.date)) {
      next = { date: l.expiresOn, units: l.remainingUnits };
    } else if (l.remainingUnits > 0 && next && l.expiresOn === next.date) {
      next.units += l.remainingUnits;
    }
  }
  const waiting = credits
    .filter((c) => c.status === 'PENDING')
    .reduce((n, c) => n + c.askedUnits, 0);
  return {
    earnedUnits: earned,
    takenUnits: taken,
    pendingUnits: pending,
    lapsedUnits: lapsed,
    availableUnits: available,
    claimsWaitingUnits: waiting,
    nextExpiry: next,
  };
}

/** Units still free (valid today, not drawn) on one credit; 0 when not approved. */
export function freeUnitsOf(alloc: CompOffAllocation, creditId: string): number {
  return alloc.lots.find((l) => l.id === creditId)?.remainingUnits ?? 0;
}

/** "1 day", "0.5 day" of comp off. */
export function compOffDays(units: number): string {
  return formatDays(units);
}
