import { Inject, Injectable, Logger } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import { SETTINGS_STORE, SettingsStore } from '@modules/settings/domain/settings.store';
import {
  APPROVER_ROUTE_LABEL,
  APPROVER_ROUTES,
  ApproverRoute,
} from '@modules/leave/domain/leave-policy';
import {
  applyWfhPatch,
  CREDIT_BASES,
  CREDIT_BASIS_LABEL,
  CreditBasis,
  WFH_POLICY_BOUNDS,
  WFH_POLICY_KEY,
  WfhPolicy,
  WfhPolicyKey,
  wfhPolicyFromStored,
} from '../domain/wfh-policy';

const CACHE_MS = 15_000;

export interface WfhPolicyView extends WfhPolicy {
  approverLabel: string;
  creditBasisLabel: string;
  routes: { value: ApproverRoute; label: string }[];
  bases: { value: CreditBasis; label: string }[];
  bounds: typeof WFH_POLICY_BOUNDS;
  /** The rule in a sentence, for the forms. */
  rule: string;
  canEdit: boolean;
  canRoute: boolean;
}

/** 4.0: each organisation keeps its own work-from-home policy, like its leave policy. */
export function wfhPolicyKey(companyId: string | null): string {
  return companyId ? `${WFH_POLICY_KEY}:${companyId}` : WFH_POLICY_KEY;
}

/**
 * The work-from-home policy (3.5), per organisation in 4.0 (until an organisation
 * saves its own, it reads the platform's), through a short cache like the other
 * settings.
 */
@Injectable()
export class WfhPolicyService {
  private readonly logger = new Logger(WfhPolicyService.name);
  private readonly cached = new Map<string, { value: WfhPolicy; at: number }>();

  constructor(@Inject(SETTINGS_STORE) private readonly store: SettingsStore) {}

  /** The organisation's stored policy, else the platform's. */
  private async stored(companyId: string | null): Promise<unknown | null> {
    const own = companyId ? await this.store.read(wfhPolicyKey(companyId)) : null;
    return own ?? (await this.store.read(WFH_POLICY_KEY));
  }

  async get(companyId: string | null): Promise<WfhPolicy> {
    const key = wfhPolicyKey(companyId);
    const at = Date.now();
    const hit = this.cached.get(key);
    if (hit && at - hit.at < CACHE_MS) return hit.value;
    const value = wfhPolicyFromStored(await this.stored(companyId));
    if (this.cached.size > 1000) this.cached.clear();
    this.cached.set(key, { value, at });
    return value;
  }

  /** Each person's policy, by their organisation (one read per organisation). */
  async forPeople(
    people: { companyId: string | null }[],
  ): Promise<(p: { companyId: string | null }) => WfhPolicy> {
    const orgs = [...new Set(people.map((p) => p.companyId))];
    const byOrg = new Map(
      await Promise.all(orgs.map(async (o) => [o, await this.get(o)] as const)),
    );
    return (p) => byOrg.get(p.companyId) ?? wfhPolicyFromStored(null);
  }

  async update(
    companyId: string | null,
    patch: Record<string, unknown>,
    opts: { mayRoute: boolean; updatedById: string },
  ): Promise<{ before: WfhPolicy; after: WfhPolicy; changed: WfhPolicyKey[] }> {
    const key = wfhPolicyKey(companyId);
    const before = wfhPolicyFromStored(await this.stored(companyId));
    const result = applyWfhPatch(before, patch, { mayRoute: opts.mayRoute });
    if (!result.ok) {
      throw new ValidationError(result.message).withDetails({ field: result.field });
    }
    await this.store.write(key, result.value, opts.updatedById);
    this.cached.set(key, { value: result.value, at: Date.now() });
    if (result.changed.length) {
      this.logger.log(
        `work-from-home policy of ${companyId ?? 'the platform'} changed by ${opts.updatedById}: ` +
          result.changed.join(', '),
      );
    }
    return { before, after: result.value, changed: result.changed };
  }

  static rule(p: WfhPolicy): string {
    const notice =
      p.noticeDays === 0
        ? 'Ask any day from today'
        : `Ask at least ${p.noticeDays} ${p.noticeDays === 1 ? 'day' : 'days'} ahead`;
    const cap = p.maxDaysPerMonth === null ? '' : `, up to ${p.maxDaysPerMonth} days a month`;
    const who =
      p.approver === 'MANAGER'
        ? "Your department's managers approve it (the organisation admin without one)."
        : p.approver === 'SUPER_MANAGER'
          ? 'The Super Manager approves it.'
          : 'The organisation admin approves it.';
    return `${notice}${cap}. ${who}`;
  }

  static view(p: WfhPolicy, opts: { canEdit: boolean; canRoute: boolean }): WfhPolicyView {
    return {
      ...p,
      approverLabel: APPROVER_ROUTE_LABEL[p.approver],
      creditBasisLabel: CREDIT_BASIS_LABEL[p.creditBasis],
      routes: APPROVER_ROUTES.map((value) => ({ value, label: APPROVER_ROUTE_LABEL[value] })),
      bases: CREDIT_BASES.map((value) => ({ value, label: CREDIT_BASIS_LABEL[value] })),
      bounds: WFH_POLICY_BOUNDS,
      rule: WfhPolicyService.rule(p),
      canEdit: opts.canEdit,
      canRoute: opts.canRoute,
    };
  }
}
