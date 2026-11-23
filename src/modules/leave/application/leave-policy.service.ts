import { Inject, Injectable, Logger } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { SETTINGS_STORE, SettingsStore } from '@modules/settings/domain/settings.store';
import {
  applyPolicyPatch,
  APPROVER_ROUTE_LABEL,
  APPROVER_ROUTES,
  carryCapUnits,
  LEAVE_POLICY_KEY,
  LeavePolicy,
  POLICY_BOUNDS,
  PolicyKey,
  policyFromStored,
  policyGrantUnits,
} from '../domain/leave-policy';
import {
  CATEGORY_LABEL,
  CATEGORY_NAME,
  KIND_LABEL,
  KIND_PARTS,
  LEAVE_KINDS,
  PART_LABEL,
} from '../domain/leave.types';
import { AccountPolicy } from '../domain/balance';
import { LeavePolicyView } from './leave.views';

const CACHE_MS = 15_000;

export type LivePolicy = LeavePolicy & { startedOn: string };

/** 4.0: each organisation keeps its own leave policy, like its other settings. */
export function leavePolicyKey(companyId: string | null): string {
  return companyId ? `${LEAVE_POLICY_KEY}:${companyId}` : LEAVE_POLICY_KEY;
}

/**
 * The leave policy (3.4), per organisation in 4.0 (until an organisation saves
 * its own, it reads the platform's), through a short cache like the other
 * settings. The first read records the day leave went live.
 */
@Injectable()
export class LeavePolicyService {
  private readonly logger = new Logger(LeavePolicyService.name);
  private readonly cached = new Map<string, { value: LivePolicy; at: number }>();

  constructor(@Inject(SETTINGS_STORE) private readonly store: SettingsStore) {}

  /** The organisation's stored policy, else the platform's (null: none stored yet). */
  private async stored(companyId: string | null): Promise<unknown | null> {
    const own = companyId ? await this.store.read(leavePolicyKey(companyId)) : null;
    return own ?? (await this.store.read(LEAVE_POLICY_KEY));
  }

  /** The policy of the person's organisation (the platform's without one). */
  async forUser(userId: string, now: Date = new Date()): Promise<LivePolicy> {
    return this.get(await this.store.companyOfUser(userId), now);
  }

  /** Each person's policy, by their organisation (one read per organisation). */
  async forPeople(
    people: { companyId: string | null }[],
    now: Date = new Date(),
  ): Promise<(p: { companyId: string | null }) => LivePolicy> {
    const orgs = [...new Set(people.map((p) => p.companyId))];
    const byOrg = new Map(
      await Promise.all(orgs.map(async (o) => [o, await this.get(o, now)] as const)),
    );
    return (p) => byOrg.get(p.companyId)!;
  }

  async get(companyId: string | null, now: Date = new Date()): Promise<LivePolicy> {
    const key = leavePolicyKey(companyId);
    const at = Date.now();
    const hit = this.cached.get(key);
    if (hit && at - hit.at < CACHE_MS) return hit.value;
    const policy = policyFromStored(await this.stored(companyId));
    if (!policy.startedOn) {
      policy.startedOn = dateKeyInZone(now, appTimezone());
      await this.store.write(key, policy, null);
      this.logger.log(`leave went live on ${policy.startedOn} for ${companyId ?? 'the platform'}`);
    }
    const value = policy as LivePolicy;
    if (this.cached.size > 1000) this.cached.clear();
    this.cached.set(key, { value, at });
    return value;
  }

  /** 400 VALIDATION_ERROR with `details.field` when a value is out of bounds. */
  async update(
    companyId: string | null,
    patch: Record<string, unknown>,
    opts: { mayRoute: boolean; updatedById: string },
  ): Promise<{ before: LivePolicy; after: LivePolicy; changed: PolicyKey[] }> {
    const key = leavePolicyKey(companyId);
    const before = await this.get(companyId);
    const fresh = policyFromStored(await this.stored(companyId));
    const current = { ...fresh, startedOn: fresh.startedOn ?? before.startedOn } as LivePolicy;
    const result = applyPolicyPatch(current, patch, { mayRoute: opts.mayRoute });
    if (!result.ok) {
      throw new ValidationError(result.message, 'VALIDATION_ERROR').withDetails({
        field: result.field,
      });
    }
    const after = result.value as LivePolicy;
    await this.store.write(key, after, opts.updatedById);
    this.cached.set(key, { value: after, at: Date.now() });
    if (result.changed.length) {
      this.logger.log(`leave policy changed by ${opts.updatedById}: ${result.changed.join(', ')}`);
    }
    return { before: current, after, changed: result.changed };
  }

  /** What account creation needs from the policy. */
  static accountPolicy(p: LivePolicy): AccountPolicy {
    return {
      startedOn: p.startedOn,
      prorateJoiners: p.prorateJoiners,
      grantUnits: { CLSL: policyGrantUnits(p, 'CLSL'), ELPL: policyGrantUnits(p, 'ELPL') },
      carryCapUnits: carryCapUnits(p),
    };
  }

  static view(
    p: LivePolicy,
    opts: { canEdit: boolean; canRoute: boolean; now: Date },
  ): LeavePolicyView {
    const cap = p.elplCarryCapDays;
    return {
      enabled: p.enabled,
      clslDaysPerYear: p.clslDaysPerYear,
      elplDaysPerYear: p.elplDaysPerYear,
      elplCarryCapDays: cap,
      elplNoticeDays: p.elplNoticeDays,
      clslBackdateDays: p.clslBackdateDays,
      approver: p.approver,
      approverLabel: APPROVER_ROUTE_LABEL[p.approver],
      prorateJoiners: p.prorateJoiners,
      startedOn: p.startedOn,
      year: Number(dateKeyInZone(opts.now, appTimezone()).slice(0, 4)),
      routes: APPROVER_ROUTES.map((value) => ({ value, label: APPROVER_ROUTE_LABEL[value] })),
      categories: [
        {
          category: 'CLSL',
          label: CATEGORY_LABEL.CLSL,
          name: CATEGORY_NAME.CLSL,
          daysPerYear: p.clslDaysPerYear,
          yearEnd: 'LAPSES',
          rule:
            p.clslBackdateDays > 0
              ? `Any day, today included, or up to ${p.clslBackdateDays} days back. What is left lapses on 31 December.`
              : 'Any day from today. What is left lapses on 31 December.',
        },
        {
          category: 'ELPL',
          label: CATEGORY_LABEL.ELPL,
          name: CATEGORY_NAME.ELPL,
          daysPerYear: p.elplDaysPerYear,
          yearEnd: 'CARRIES',
          rule:
            (p.elplNoticeDays > 0
              ? `Apply at least ${p.elplNoticeDays} days ahead. `
              : 'Apply any day ahead. ') +
            (cap === null
              ? 'What is left carries over to next year.'
              : `Up to ${cap} days carry over to next year; the rest lapses.`),
        },
      ],
      kinds: LEAVE_KINDS.map((kind) => ({
        kind,
        label: KIND_LABEL[kind],
        days: kind === 'FULL_DAY' ? 1 : kind === 'HALF_DAY' ? 0.5 : 0.25,
        parts: KIND_PARTS[kind].map((part) => ({ part, label: PART_LABEL[part] })),
      })),
      bounds: { ...POLICY_BOUNDS },
      canEdit: opts.canEdit,
      canRoute: opts.canRoute,
    };
  }
}
