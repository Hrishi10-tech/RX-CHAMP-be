import { APPROVER_ROUTES, ApproverRoute } from '@modules/leave/domain/leave-policy';

/**
 * The work-from-home policy (3.5), one JSON value in app_settings (key `wfh`). Set
 * by the Super Admin and the Super Manager; who approves is the Super Admin's
 * alone. Pure: no Nest, no Prisma.
 */

export const WFH_POLICY_KEY = 'wfh';

export const CREDIT_BASES = ['SHIFT_LENGTH', 'EXPECTED'] as const;
export type CreditBasis = (typeof CREDIT_BASES)[number];

export const CREDIT_BASIS_LABEL: Record<CreditBasis, string> = {
  SHIFT_LENGTH: 'The shift length, start to end (a 09:00 to 18:00 shift: 9 hours)',
  EXPECTED:
    "The shift's expected time, without its breaks (09:00 to 18:00 with 1 hour of breaks: 8 hours)",
};

export interface WfhPolicy {
  /** Off: nobody can ask; schedules and history stay, and nothing new starts. */
  enabled: boolean;
  /** A request's first day is at least this many days after the day it is made (0: the same day). */
  noticeDays: number;
  /** At most this many days of work from home a month, waiting and approved together; null: no cap. */
  maxDaysPerMonth: number | null;
  /** Who decides: the person's manager (their reporting person), the Super Manager, or the Super Admins. */
  approver: ApproverRoute;
  /** What a full day of work from home credits at most (biometric staff, on the phone). */
  creditBasis: CreditBasis;
}

export type WfhPolicyKey = keyof WfhPolicy;

export const DEFAULT_WFH_POLICY: Readonly<WfhPolicy> = Object.freeze({
  enabled: true,
  noticeDays: 1,
  maxDaysPerMonth: null,
  approver: 'MANAGER',
  creditBasis: 'SHIFT_LENGTH',
});

export const WFH_POLICY_BOUNDS = Object.freeze({
  noticeDays: { min: 0, max: 30 },
  maxDaysPerMonth: { min: 1, max: 31 },
});

export const WFH_FIELD_LABEL: Record<WfhPolicyKey, string> = {
  enabled: 'Work from home',
  noticeDays: 'Notice (days ahead)',
  maxDaysPerMonth: 'Days a month at most',
  approver: 'Who approves work from home',
  creditBasis: 'A full day from home counts at most',
};

function wholeIn(v: unknown, b: { min: number; max: number }): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max;
}

/** What is stored, made whole: anything unreadable falls back to its default. */
export function wfhPolicyFromStored(raw: unknown): WfhPolicy {
  const out: WfhPolicy = { ...DEFAULT_WFH_POLICY };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (wholeIn(r.noticeDays, WFH_POLICY_BOUNDS.noticeDays)) out.noticeDays = r.noticeDays;
  if (r.maxDaysPerMonth === null || wholeIn(r.maxDaysPerMonth, WFH_POLICY_BOUNDS.maxDaysPerMonth)) {
    out.maxDaysPerMonth = r.maxDaysPerMonth as number | null;
  }
  if (
    typeof r.approver === 'string' &&
    (APPROVER_ROUTES as readonly string[]).includes(r.approver)
  ) {
    out.approver = r.approver as ApproverRoute;
  }
  if (
    typeof r.creditBasis === 'string' &&
    (CREDIT_BASES as readonly string[]).includes(r.creditBasis)
  ) {
    out.creditBasis = r.creditBasis as CreditBasis;
  }
  return out;
}

export type WfhPatchResult =
  | { ok: true; value: WfhPolicy; changed: WfhPolicyKey[] }
  | { ok: false; field: string; message: string };

/** A partial change; unknown keys are refused. `mayRoute`: only a Super Admin changes who approves. */
export function applyWfhPatch(
  current: WfhPolicy,
  patch: Record<string, unknown>,
  opts: { mayRoute: boolean },
): WfhPatchResult {
  const next: WfhPolicy = { ...current };
  const known = new Set(Object.keys(DEFAULT_WFH_POLICY));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!known.has(key))
      return { ok: false, field: key, message: `${key} is not a work-from-home setting.` };
    switch (key as WfhPolicyKey) {
      case 'enabled':
        if (typeof value !== 'boolean') {
          return { ok: false, field: key, message: 'Work from home must be on or off.' };
        }
        next.enabled = value;
        break;
      case 'noticeDays': {
        const b = WFH_POLICY_BOUNDS.noticeDays;
        if (!wholeIn(value, b)) {
          return {
            ok: false,
            field: key,
            message: `Notice must be a whole number of days from ${b.min} to ${b.max}.`,
          };
        }
        next.noticeDays = value;
        break;
      }
      case 'maxDaysPerMonth': {
        const b = WFH_POLICY_BOUNDS.maxDaysPerMonth;
        if (value !== null && !wholeIn(value, b)) {
          return {
            ok: false,
            field: key,
            message: `Days a month must be ${b.min} to ${b.max}, or empty for no cap.`,
          };
        }
        next.maxDaysPerMonth = value as number | null;
        break;
      }
      case 'approver':
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
            message: 'Only a Super Admin can change who approves work from home.',
          };
        }
        next.approver = value as ApproverRoute;
        break;
      case 'creditBasis':
        if (typeof value !== 'string' || !(CREDIT_BASES as readonly string[]).includes(value)) {
          return { ok: false, field: key, message: 'Pick SHIFT_LENGTH or EXPECTED.' };
        }
        next.creditBasis = value as CreditBasis;
        break;
    }
  }
  const changed = (Object.keys(next) as WfhPolicyKey[]).filter((k) => next[k] !== current[k]);
  return { ok: true, value: next, changed };
}
