import { isValidDateKey } from '@shared/utils/timezone';
import { LeaveCategory, UNITS_PER_DAY, unitsOfDays } from './leave.types';

/**
 * The leave policy (3.4), one JSON value in app_settings (key `leave`). Set by the
 * Super Admin and the Super Manager; who approves is the Super Admin's alone.
 * Pure: no Nest, no Prisma.
 */

export const LEAVE_POLICY_KEY = 'leave';

export const APPROVER_ROUTES = ['MANAGER', 'SUPER_MANAGER', 'SUPER_ADMIN'] as const;
export type ApproverRoute = (typeof APPROVER_ROUTES)[number];

export const APPROVER_ROUTE_LABEL: Record<ApproverRoute, string> = {
  MANAGER: "The person's manager",
  SUPER_MANAGER: 'The Super Manager',
  SUPER_ADMIN: 'The Super Admins',
};

export interface LeavePolicy {
  /** Off: nobody can apply; balances and history stay readable. */
  enabled: boolean;
  /** CL/SL given to each person on 1 January (their own quota wins). Lapses on 31 December. */
  clslDaysPerYear: number;
  /** EL/PL given to each person on 1 January (their own quota wins). Carries over. */
  elplDaysPerYear: number;
  /** EL/PL brought into a new year at most; null = all of it. */
  elplCarryCapDays: number | null;
  /** EL/PL: the first day must be at least this many days after the day of the request. */
  elplNoticeDays: number;
  /** CL/SL: may cover days up to this many days back (sick leave is often applied on return). */
  clslBackdateDays: number;
  /** Who decides a request. */
  approver: ApproverRoute;
  /** A person who joins during a year gets that year's grant pro rata. */
  prorateJoiners: boolean;
  /**
   * The day leave went live (YYYY-MM-DD), written once. Everyone already here then
   * starts that year with the full grant; people who join later are prorated.
   */
  startedOn: string | null;
}

export type PolicyKey = Exclude<keyof LeavePolicy, 'startedOn'>;

export const DEFAULT_LEAVE_POLICY: Readonly<LeavePolicy> = Object.freeze({
  enabled: true,
  clslDaysPerYear: 12,
  elplDaysPerYear: 12,
  elplCarryCapDays: null,
  elplNoticeDays: 5,
  clslBackdateDays: 7,
  approver: 'MANAGER',
  prorateJoiners: true,
  startedOn: null,
});

/** Inclusive bounds; day amounts go in quarter days, the rest in whole days. */
export const POLICY_BOUNDS = Object.freeze({
  clslDaysPerYear: { min: 0, max: 60 },
  elplDaysPerYear: { min: 0, max: 60 },
  elplCarryCapDays: { min: 0, max: 365 },
  elplNoticeDays: { min: 0, max: 120 },
  clslBackdateDays: { min: 0, max: 62 },
});

const DAY_AMOUNT_KEYS = ['clslDaysPerYear', 'elplDaysPerYear', 'elplCarryCapDays'] as const;
const WHOLE_KEYS = ['elplNoticeDays', 'clslBackdateDays'] as const;
const BOOL_KEYS = ['enabled', 'prorateJoiners'] as const;

export const POLICY_FIELD_LABEL: Record<PolicyKey, string> = {
  enabled: 'Leave',
  clslDaysPerYear: 'CL/SL days a year',
  elplDaysPerYear: 'EL/PL days a year',
  elplCarryCapDays: 'EL/PL carry-over cap',
  elplNoticeDays: 'EL/PL notice',
  clslBackdateDays: 'CL/SL backdating',
  approver: 'Who approves',
  prorateJoiners: 'Pro rata for joiners',
};

function dayAmountOk(v: unknown, key: (typeof DAY_AMOUNT_KEYS)[number]): v is number {
  const b = POLICY_BOUNDS[key];
  return typeof v === 'number' && v >= b.min && v <= b.max && unitsOfDays(v) !== null;
}

function wholeOk(v: unknown, key: (typeof WHOLE_KEYS)[number]): v is number {
  const b = POLICY_BOUNDS[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max;
}

/** What is stored, made whole: anything unreadable falls back to its default. */
export function policyFromStored(raw: unknown): LeavePolicy {
  const out: LeavePolicy = { ...DEFAULT_LEAVE_POLICY };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const k of BOOL_KEYS) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
  if (dayAmountOk(r.clslDaysPerYear, 'clslDaysPerYear')) out.clslDaysPerYear = r.clslDaysPerYear;
  if (dayAmountOk(r.elplDaysPerYear, 'elplDaysPerYear')) out.elplDaysPerYear = r.elplDaysPerYear;
  if (r.elplCarryCapDays === null || dayAmountOk(r.elplCarryCapDays, 'elplCarryCapDays')) {
    out.elplCarryCapDays = r.elplCarryCapDays as number | null;
  }
  for (const k of WHOLE_KEYS) if (wholeOk(r[k], k)) out[k] = r[k] as number;
  if (
    typeof r.approver === 'string' &&
    (APPROVER_ROUTES as readonly string[]).includes(r.approver)
  ) {
    out.approver = r.approver as ApproverRoute;
  }
  if (typeof r.startedOn === 'string' && isValidDateKey(r.startedOn)) out.startedOn = r.startedOn;
  return out;
}

export type PolicyPatchResult =
  | { ok: true; value: LeavePolicy; changed: PolicyKey[] }
  | { ok: false; field: string; message: string };

/**
 * Applies a partial change. `mayRoute` is false for the Super Manager: who approves
 * is the Super Admin's decision. Unknown keys are refused, so a typo never passes
 * silently.
 */
export function applyPolicyPatch(
  current: LeavePolicy,
  patch: Record<string, unknown>,
  opts: { mayRoute: boolean },
): PolicyPatchResult {
  const next: LeavePolicy = { ...current };
  const changed: PolicyKey[] = [];
  const known = new Set<string>([...BOOL_KEYS, ...DAY_AMOUNT_KEYS, ...WHOLE_KEYS, 'approver']);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!known.has(key)) {
      return { ok: false, field: key, message: `${key} is not a leave setting.` };
    }
    if ((BOOL_KEYS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') {
        return {
          ok: false,
          field: key,
          message: `${POLICY_FIELD_LABEL[key as PolicyKey]} must be on or off.`,
        };
      }
      (next as unknown as Record<string, unknown>)[key] = value;
    } else if ((DAY_AMOUNT_KEYS as readonly string[]).includes(key)) {
      const k = key as (typeof DAY_AMOUNT_KEYS)[number];
      if (k === 'elplCarryCapDays' && value === null) {
        next.elplCarryCapDays = null;
      } else if (!dayAmountOk(value, k)) {
        const b = POLICY_BOUNDS[k];
        return {
          ok: false,
          field: key,
          message: `${POLICY_FIELD_LABEL[k]} must be ${b.min} to ${b.max} days, in quarter days (0.25, 0.5, 0.75).`,
        };
      } else {
        next[k] = value as number;
      }
    } else if ((WHOLE_KEYS as readonly string[]).includes(key)) {
      const k = key as (typeof WHOLE_KEYS)[number];
      if (!wholeOk(value, k)) {
        const b = POLICY_BOUNDS[k];
        return {
          ok: false,
          field: key,
          message: `${POLICY_FIELD_LABEL[k]} must be a whole number of days from ${b.min} to ${b.max}.`,
        };
      }
      next[k] = value as number;
    } else if (key === 'approver') {
      if (typeof value !== 'string' || !(APPROVER_ROUTES as readonly string[]).includes(value)) {
        return {
          ok: false,
          field: key,
          message: 'Who approves must be MANAGER, SUPER_MANAGER or SUPER_ADMIN.',
        };
      }
      if (!opts.mayRoute && value !== current.approver) {
        return {
          ok: false,
          field: key,
          message: 'Only a Super Admin can change who approves leave.',
        };
      }
      next.approver = value as ApproverRoute;
    }
    const k = key as PolicyKey;
    if (next[k] !== current[k]) changed.push(k);
  }
  return { ok: true, value: next, changed };
}

/** The policy's yearly grant of a pool, in quarter days. */
export function policyGrantUnits(policy: LeavePolicy, category: LeaveCategory): number {
  const days = category === 'CLSL' ? policy.clslDaysPerYear : policy.elplDaysPerYear;
  return Math.round(days * UNITS_PER_DAY);
}

/** The EL/PL carry-over cap in quarter days (null: no cap). */
export function carryCapUnits(policy: LeavePolicy): number | null {
  return policy.elplCarryCapDays === null
    ? null
    : Math.round(policy.elplCarryCapDays * UNITS_PER_DAY);
}
