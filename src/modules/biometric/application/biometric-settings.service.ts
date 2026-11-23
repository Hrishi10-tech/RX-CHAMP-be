import { Inject, Injectable, Logger } from '@nestjs/common';
import { API_COPY } from '@shared/copy/api-copy';
import { ValidationError } from '@shared/exceptions/app.exception';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { SETTINGS_STORE, SettingsStore } from '@modules/settings/domain/settings.store';
import {
  applyBiometricPatch,
  BIOMETRIC_BOUNDS,
  BIOMETRIC_PULL_STATE_KEY,
  BIOMETRIC_SECRET_KEY,
  BIOMETRIC_SETTINGS_KEY,
  BiometricSettings,
  biometricFromStored,
} from '../domain/biometric-settings';
import { BIOMETRIC_REPOSITORY, BiometricRepository } from '../domain/biometric.repository';

const CACHE_MS = 15_000;

/** The pull's last run, kept apart from the settings (it changes every few minutes). */
export interface PullState {
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastCount: number;
  /** The newest punch time read so far (the next run starts from it, less the overlap). */
  cursor: string | null;
}

export const EMPTY_PULL_STATE: PullState = {
  lastRunAt: null,
  lastOkAt: null,
  lastError: null,
  lastCount: 0,
  cursor: null,
};

/**
 * 4.0: each organisation runs its own biometric integration, so its settings, the
 * pull's secret and the pull's state are stored under keys of its own. Nothing
 * falls back to another organisation's or the platform's (a pull URL or secret is
 * never shared).
 */
export function biometricKeys(companyId: string) {
  return {
    settings: `${BIOMETRIC_SETTINGS_KEY}:${companyId}`,
    secret: `${BIOMETRIC_SECRET_KEY}:${companyId}`,
    pullState: `${BIOMETRIC_PULL_STATE_KEY}:${companyId}`,
  };
}

/** One stretch of days the integration was on (3.6), as the portal shows it. */
export interface IntegrationPeriodView {
  fromDate: string;
  toDate: string | null;
  startedAt: string;
  endedAt: string | null;
  startedByName: string | null;
  endedByName: string | null;
}

/**
 * Biometric settings (3.5, per organisation in 4.0), the pull's secret kept apart and
 * never shown, and the integration switch (3.6): off until the organisation's admin turns
 * it on. While it is off, the organisation's biometric staff's payroll is paused; each
 * stretch it was on stays in the organisation's history, and that history decides which
 * of their days are calculated. Another organisation's switch never touches them.
 */
@Injectable()
export class BiometricSettingsService {
  private readonly logger = new Logger(BiometricSettingsService.name);
  private readonly cached = new Map<string, { value: BiometricSettings; at: number }>();

  constructor(
    @Inject(SETTINGS_STORE) private readonly store: SettingsStore,
    @Inject(BIOMETRIC_REPOSITORY) private readonly repo: BiometricRepository,
  ) {}

  async get(companyId: string): Promise<BiometricSettings> {
    const at = Date.now();
    const hit = this.cached.get(companyId);
    if (hit && at - hit.at < CACHE_MS) return hit.value;
    const value = biometricFromStored(await this.store.read(biometricKeys(companyId).settings));
    if (this.cached.size > 1000) this.cached.clear();
    this.cached.set(companyId, { value, at });
    return value;
  }

  async update(
    companyId: string,
    patch: Record<string, unknown>,
    byId: string,
    now: Date = new Date(),
  ): Promise<{ after: BiometricSettings; changed: string[] }> {
    const keys = biometricKeys(companyId);
    const { secret, password, integrationOn, ...rest } = patch as Record<string, unknown> & {
      secret?: unknown;
      password?: unknown;
      integrationOn?: unknown;
    };
    if (integrationOn !== undefined && typeof integrationOn !== 'boolean') {
      throw new ValidationError(API_COPY.pickOnOrOff).withDetails({ field: 'integrationOn' });
    }
    const current = biometricFromStored(await this.store.read(keys.settings));
    const result = applyBiometricPatch(current, rest);
    if (!result.ok) throw new ValidationError(result.message).withDetails({ field: result.field });
    const changed = [...result.changed];
    if (secret !== undefined || password !== undefined) {
      const kept = await this.secrets(companyId);
      const next = { ...kept };
      for (const [k, v] of [
        ['secret', secret],
        ['password', password],
      ] as const) {
        if (v === undefined) continue;
        if (v !== null && (typeof v !== 'string' || v.length > 4000)) {
          throw new ValidationError(`${k} must be text of at most 4000 characters.`).withDetails({
            field: k,
          });
        }
        next[k] = v === null || v === '' ? null : v;
        changed.push(k);
      }
      await this.store.write(keys.secret, next, byId);
    }
    await this.store.write(keys.settings, result.value, byId);
    this.cached.set(companyId, { value: result.value, at: Date.now() });
    // 3.6: the organisation's own switch. On counts today in full; off keeps today (it was on).
    if (typeof integrationOn === 'boolean') {
      const today = dateKeyInZone(now, appTimezone());
      if (await this.repo.switchIntegration(companyId, integrationOn, today, now, byId)) {
        changed.push('integrationOn');
      }
    }
    if (changed.length) {
      this.logger.log(
        `biometric settings of ${companyId} changed by ${byId}: ${changed.join(', ')}`,
      );
    }
    return { after: result.value, changed };
  }

  /** The pull's API token and password (server side only). */
  async secrets(companyId: string): Promise<{ secret: string | null; password: string | null }> {
    const raw = (await this.store.read(biometricKeys(companyId).secret)) as Record<
      string,
      unknown
    > | null;
    return {
      secret: typeof raw?.secret === 'string' ? raw.secret : null,
      password: typeof raw?.password === 'string' ? raw.password : null,
    };
  }

  async pullState(companyId: string): Promise<PullState> {
    const raw = (await this.store.read(
      biometricKeys(companyId).pullState,
    )) as Partial<PullState> | null;
    return { ...EMPTY_PULL_STATE, ...(raw && typeof raw === 'object' ? raw : {}) };
  }

  async savePullState(companyId: string, state: PullState): Promise<void> {
    await this.store.write(biometricKeys(companyId).pullState, state, null);
  }

  /** The organisation's integration switch and its history, newest first (3.6). */
  async integration(companyId: string): Promise<{ on: boolean; periods: IntegrationPeriodView[] }> {
    const rows = await this.repo.integrationPeriods(companyId);
    return {
      on: rows.some((r) => r.toDate === null),
      periods: rows.map((r) => ({
        fromDate: r.fromDate,
        toDate: r.toDate,
        startedAt: r.startedAt.toISOString(),
        endedAt: r.endedAt?.toISOString() ?? null,
        startedByName: r.startedByName,
        endedByName: r.endedByName,
      })),
    };
  }

  /** What the portal shows: the settings, which secrets are set (never their values). */
  async view(companyId: string): Promise<
    BiometricSettings & {
      secretSet: boolean;
      passwordSet: boolean;
      bounds: typeof BIOMETRIC_BOUNDS;
      integrationOn: boolean;
      integrationPeriods: IntegrationPeriodView[];
    }
  > {
    const [s, secrets, integration] = await Promise.all([
      this.get(companyId),
      this.secrets(companyId),
      this.integration(companyId),
    ]);
    return {
      ...s,
      secretSet: !!secrets.secret,
      passwordSet: !!secrets.password,
      bounds: BIOMETRIC_BOUNDS,
      integrationOn: integration.on,
      integrationPeriods: integration.periods,
    };
  }
}
