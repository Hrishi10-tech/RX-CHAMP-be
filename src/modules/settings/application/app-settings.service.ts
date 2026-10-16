import { Inject, Injectable, Logger } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import {
  AppSettings,
  SETTINGS_KEY,
  SettingKey,
  applySettingsPatch,
  settingsFromStored,
} from '../domain/settings.rules';
import { SETTINGS_STORE, SettingsStore } from '../domain/settings.store';

/** How long a read is reused. Writes go through this process and clear it at once. */
const CACHE_MS = 15_000;

/**
 * The organisation settings, read through a short in-process cache because
 * almost every working-day request needs one of them. The API runs as a single
 * process (ecosystem.config.js), so clearing the cache on write is enough.
 */
@Injectable()
export class AppSettingsService {
  private readonly logger = new Logger(AppSettingsService.name);
  private cached: { value: AppSettings; at: number } | null = null;

  constructor(@Inject(SETTINGS_STORE) private readonly store: SettingsStore) {}

  async get(): Promise<AppSettings> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    const value = settingsFromStored(await this.store.read(SETTINGS_KEY));
    this.cached = { value, at: now };
    return value;
  }

  /** Applies a partial update; 400 VALIDATION_ERROR with `details.field` when out of bounds. */
  async update(
    patch: Partial<Record<SettingKey, unknown>>,
    updatedById: string,
  ): Promise<AppSettings> {
    const current = settingsFromStored(await this.store.read(SETTINGS_KEY));
    const result = applySettingsPatch(current, patch);
    if (!result.ok) {
      throw new ValidationError(result.message, 'VALIDATION_ERROR').withDetails({
        field: result.field,
      });
    }
    await this.store.write(SETTINGS_KEY, result.value, updatedById);
    this.cached = { value: result.value, at: Date.now() };
    if (result.changed.length) {
      this.logger.log(`settings changed by ${updatedById}: ${result.changed.join(', ')}`);
    }
    return result.value;
  }
}
