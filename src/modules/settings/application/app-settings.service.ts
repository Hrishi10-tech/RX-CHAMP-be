import { Inject, Injectable, Logger } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import {
  AppSettings,
  SETTINGS_KEY,
  SettingKey,
  applySettingsPatch,
  orgSettingsKey,
  settingsFromStored,
} from '../domain/settings.rules';
import { SETTINGS_STORE, SettingsStore } from '../domain/settings.store';
import {
  effectiveIdle,
  EffectiveIdle,
  idleFromStored,
  OrgIdleSettings,
} from '../domain/idle.rules';

/** How long a read is reused. Writes go through this process and clear it at once. */
const CACHE_MS = 15_000;
/** How long a person's organisation is remembered for settings lookups. */
const USER_ORG_MS = 60_000;

type Raw = Record<string, unknown>;

function asObject(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as Raw) } : {};
}

/**
 * Organisation settings, per organisation since 4.0 (app_settings key
 * `org:<companyId>`, falling back to the 3.x `org` row until the organisation
 * saves its own), read through a short in-process cache because almost every
 * working-day request needs one of them. The API runs as a single process
 * (ecosystem.config.js), so clearing the cache on write is enough.
 *
 * The row is one JSON object: the settings table (settings.rules) plus sections
 * other modules own (`weekPattern`, the input-tracking keys). Each writer changes
 * only its own keys and keeps the rest.
 */
@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);
  private readonly raw = new Map<string, { value: Raw; at: number }>();
  private readonly userOrg = new Map<string, { companyId: string | null; at: number }>();

  constructor(@Inject(SETTINGS_STORE) private readonly store: SettingsStore) {}

  /** The organisation's raw JSON object (its own row, else the 3.x row, else empty). */
  async readRaw(companyId: string | null | undefined): Promise<Raw> {
    const key = companyId ? orgSettingsKey(companyId) : SETTINGS_KEY;
    const now = Date.now();
    const hit = this.raw.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value;
    let stored = await this.store.read(key);
    if (stored == null && companyId) stored = await this.store.read(SETTINGS_KEY);
    const value = asObject(stored);
    if (this.raw.size > 500) this.raw.clear();
    this.raw.set(key, { value, at: now });
    return value;
  }

  /** Changes some keys of the organisation's row, keeping every other key. */
  async writeRaw(companyId: string, patch: Raw, updatedById: string | null): Promise<Raw> {
    const key = orgSettingsKey(companyId);
    let stored = await this.store.read(key);
    if (stored == null) stored = await this.store.read(SETTINGS_KEY);
    const next = { ...asObject(stored), ...patch };
    await this.store.write(key, next, updatedById);
    this.raw.set(key, { value: next, at: Date.now() });
    return next;
  }

  /** The settings table of an organisation (no organisation: the 3.x row or defaults). */
  async get(companyId?: string | null): Promise<AppSettings> {
    return settingsFromStored(await this.readRaw(companyId ?? null));
  }

  /** The settings of the organisation a person belongs to. */
  async forUser(userId: string): Promise<AppSettings> {
    return this.get(await this.companyOfUser(userId));
  }

  async companyOfUser(userId: string): Promise<string | null> {
    const now = Date.now();
    const hit = this.userOrg.get(userId);
    if (hit && now - hit.at < USER_ORG_MS) return hit.companyId;
    const companyId = await this.store.companyOfUser(userId);
    if (this.userOrg.size > 5000) this.userOrg.clear();
    this.userOrg.set(userId, { companyId, at: now });
    return companyId;
  }

  /** 4.0: the organisation's input-tracking settings. */
  async idle(companyId: string | null): Promise<OrgIdleSettings> {
    return idleFromStored(await this.readRaw(companyId));
  }

  /** 4.0: a person's effective input tracking (their override, their department, the organisation). */
  async effectiveIdleFor(userId: string): Promise<EffectiveIdle> {
    const facts = await this.store.idleFactsOfUser(userId);
    const org = await this.idle(facts?.companyId ?? null);
    return effectiveIdle(org, facts?.departmentId ?? null, {
      idleEnabled: facts?.idleEnabled ?? null,
      idleMinutes: facts?.idleMinutes ?? null,
    });
  }

  /** Forget a person's cached organisation (they moved). */
  forgetUser(userId: string): void {
    this.userOrg.delete(userId);
  }

  /** Applies a partial update; 400 VALIDATION_ERROR with `details.field` when out of bounds. */
  async update(
    companyId: string,
    patch: Partial<Record<SettingKey, unknown>>,
    updatedById: string,
  ): Promise<AppSettings> {
    const current = settingsFromStored(await this.readRaw(companyId));
    const result = applySettingsPatch(current, patch);
    if (!result.ok) {
      throw new ValidationError(result.message, 'VALIDATION_ERROR').withDetails({
        field: result.field,
      });
    }
    await this.writeRaw(companyId, { ...result.value }, updatedById);
    if (result.changed.length) {
      this.logger.log(
        `settings of ${companyId} changed by ${updatedById}: ${result.changed.join(', ')}`,
      );
    }
    return result.value;
  }
}
