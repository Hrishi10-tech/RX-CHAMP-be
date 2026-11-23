import { PoolCategory, UNITS_PER_DAY } from './leave.types';

/**
 * Balances (3.4), in quarter days. Pure: no Nest, no Prisma.
 *
 * A person has one account per pool per year, holding what was granted for that
 * year and (EL/PL) the carry-over cap in force when it was opened. Everything else
 * is worked out from the requests and the manual adjustments, so a late decision
 * on an old request or an adjustment to a past year flows through by itself:
 *
 *   balance(Y)   = granted(Y) + carried(Y) + adjusted(Y) − taken(Y)
 *   available(Y) = balance(Y) − pending(Y)
 *   carried(Y)   = CL/SL: 0 (it lapses)
 *                  EL/PL: balance(Y−1), at most the cap of Y (a debt carries in full)
 */

export interface AccountFigures {
  year: number;
  grantedUnits: number;
  /** EL/PL: the cap in force when the account was opened; null = no cap. */
  carryCapUnits: number | null;
  /** Sum of the manual adjustments to this pool for this year (signed). */
  adjustedUnits: number;
  /** Approved leave in this pool and year. */
  takenUnits: number;
  /** Leave waiting for a decision, reserved. */
  pendingUnits: number;
}

export interface YearBalance {
  year: number;
  category: PoolCategory;
  grantedUnits: number;
  carriedUnits: number;
  /** What last year's balance had left that did not come over (over the cap, or CL/SL lapsing). */
  lapsedUnits: number;
  adjustedUnits: number;
  takenUnits: number;
  pendingUnits: number;
  balanceUnits: number;
  availableUnits: number;
}

/**
 * Every year's balance for one pool. Years must be contiguous to carry: a missing
 * year breaks the chain (nothing is carried across a gap).
 */
export function yearBalances(
  category: PoolCategory,
  accounts: readonly AccountFigures[],
): Map<number, YearBalance> {
  const out = new Map<number, YearBalance>();
  const sorted = [...accounts].sort((a, b) => a.year - b.year);
  let previous: YearBalance | null = null;
  for (const a of sorted) {
    const prev: YearBalance | null = previous && previous.year === a.year - 1 ? previous : null;
    let carried = 0;
    let lapsed = 0;
    if (prev) {
      const closing = prev.balanceUnits;
      if (category === 'ELPL') {
        carried = closing < 0 ? closing : Math.min(closing, a.carryCapUnits ?? closing);
        lapsed = Math.max(0, closing - carried);
      } else {
        lapsed = Math.max(0, closing);
      }
    }
    const balance = a.grantedUnits + carried + a.adjustedUnits - a.takenUnits;
    const row: YearBalance = {
      year: a.year,
      category,
      grantedUnits: a.grantedUnits,
      carriedUnits: carried,
      lapsedUnits: lapsed,
      adjustedUnits: a.adjustedUnits,
      takenUnits: a.takenUnits,
      pendingUnits: a.pendingUnits,
      balanceUnits: balance,
      availableUnits: balance - a.pendingUnits,
    };
    out.set(a.year, row);
    previous = row;
  }
  return out;
}

/**
 * What a new request in this year may use. Before the year starts, the EL/PL
 * carried in is only a forecast (December's leave can still change it), so it is
 * not spendable until 1 January; a carried debt counts at once.
 */
export function spendableUnits(b: YearBalance, carryUsable: boolean): number {
  if (carryUsable) return b.availableUnits;
  return b.availableUnits - b.carriedUnits + Math.min(0, b.carriedUnits);
}

function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/** Days from `dateKey` to 31 December inclusive. */
function daysLeftInYear(dateKey: string): number {
  const [y, m, d] = dateKey.split('-').map(Number);
  const from = Date.UTC(y, m - 1, d);
  const end = Date.UTC(y, 11, 31);
  return Math.floor((end - from) / 86_400_000) + 1;
}

/**
 * The grant of someone who joined during the year: the days left from their first
 * day, to the nearest half day, never more than the full grant.
 */
export function proratedUnits(fullUnits: number, joinDate: string): number {
  const year = Number(joinDate.slice(0, 4));
  const share = daysLeftInYear(joinDate) / daysInYear(year);
  const half = UNITS_PER_DAY / 2;
  const units = Math.round((fullUnits * share) / half) * half;
  return Math.max(0, Math.min(fullUnits, units));
}

export interface GrantInput {
  year: number;
  /** The yearly grant that applies to the person (their quota, else the policy's). */
  fullUnits: number;
  /** The person's first day (account creation, business time zone). */
  joinDate: string;
  /** The day leave went live. */
  startedOn: string;
  prorateJoiners: boolean;
}

/**
 * What one year grants: in full, except to someone who joined during that year
 * after leave went live (pro rata, when the policy says so). People already here
 * when leave went live start that year with the full grant; their real remaining
 * balance is set by hand.
 */
export function grantFor(input: GrantInput): { grantedUnits: number; prorated: boolean } {
  const joinYear = Number(input.joinDate.slice(0, 4));
  const prorate =
    input.prorateJoiners &&
    joinYear === input.year &&
    input.joinDate > input.startedOn &&
    input.joinDate > `${input.year}-01-01`;
  if (!prorate) return { grantedUnits: input.fullUnits, prorated: false };
  return { grantedUnits: proratedUnits(input.fullUnits, input.joinDate), prorated: true };
}

/** The first year a person has accounts: the later of leave going live and their joining. */
export function firstLeaveYear(joinDate: string, startedOn: string): number {
  return Math.max(Number(joinDate.slice(0, 4)), Number(startedOn.slice(0, 4)));
}

// ---- Accounts ---------------------------------------------------------------

export interface AccountPerson {
  userId: string;
  /** First day (YYYY-MM-DD, business time zone). */
  joinDate: string;
  /** Their own yearly quota per pool, in quarter days. */
  quotas: Partial<Record<PoolCategory, number>>;
}

export interface AccountPolicy {
  startedOn: string;
  prorateJoiners: boolean;
  /** The policy's yearly grant per pool, in quarter days. */
  grantUnits: Record<PoolCategory, number>;
  /** EL/PL carry-over cap in quarter days; null = none. */
  carryCapUnits: number | null;
}

export interface AccountGrant {
  grantedUnits: number;
  grantSource: 'DEFAULT' | 'PERSON';
  prorated: boolean;
}

/** What a person's account for a year and pool grants under the policy and their quota now. */
export function grantOf(
  person: AccountPerson,
  year: number,
  category: PoolCategory,
  policy: AccountPolicy,
): AccountGrant {
  const quota = person.quotas[category];
  const full = quota ?? policy.grantUnits[category];
  const g = grantFor({
    year,
    fullUnits: full,
    joinDate: person.joinDate,
    startedOn: policy.startedOn,
    prorateJoiners: policy.prorateJoiners,
  });
  return { ...g, grantSource: quota !== undefined ? 'PERSON' : 'DEFAULT' };
}

/** The accounts a person is missing from their first leave year up to `upToYear`. */
export function missingAccounts(
  person: AccountPerson,
  existing: readonly { year: number; category: PoolCategory }[],
  upToYear: number,
  policy: AccountPolicy,
): {
  userId: string;
  year: number;
  category: PoolCategory;
  grantedUnits: number;
  grantSource: 'DEFAULT' | 'PERSON';
  prorated: boolean;
  carryCapUnits: number | null;
}[] {
  const have = new Set(existing.map((a) => `${a.year}:${a.category}`));
  const out = [];
  for (let year = firstLeaveYear(person.joinDate, policy.startedOn); year <= upToYear; year += 1) {
    for (const category of ['CLSL', 'ELPL'] as const) {
      if (have.has(`${year}:${category}`)) continue;
      out.push({
        userId: person.userId,
        year,
        category,
        ...grantOf(person, year, category, policy),
        carryCapUnits: category === 'ELPL' ? policy.carryCapUnits : null,
      });
    }
  }
  return out;
}

/** Both pools' balances, every year, from the accounts and the sums. */
export function balancesFrom(
  accounts: readonly {
    year: number;
    category: PoolCategory;
    grantedUnits: number;
    carryCapUnits: number | null;
  }[],
  sums: readonly {
    year: number;
    category: PoolCategory;
    adjustedUnits: number;
    takenUnits: number;
    pendingUnits: number;
  }[],
): Record<PoolCategory, Map<number, YearBalance>> {
  const figures = (category: PoolCategory): AccountFigures[] =>
    accounts
      .filter((a) => a.category === category)
      .map((a) => {
        const s = sums.find((x) => x.year === a.year && x.category === category);
        return {
          year: a.year,
          grantedUnits: a.grantedUnits,
          carryCapUnits: a.carryCapUnits,
          adjustedUnits: s?.adjustedUnits ?? 0,
          takenUnits: s?.takenUnits ?? 0,
          pendingUnits: s?.pendingUnits ?? 0,
        };
      });
  return {
    CLSL: yearBalances('CLSL', figures('CLSL')),
    ELPL: yearBalances('ELPL', figures('ELPL')),
  };
}
