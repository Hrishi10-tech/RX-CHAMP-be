import { Inject, Injectable, Logger } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import {
  applyPresetsPatch,
  PRESET_KIND_INFO,
  PRESET_KINDS,
  PRESET_TEXT_MAX,
  PresetKind,
  PRESETS_PER_KIND_MAX,
  presetsFromStored,
  REASON_PRESETS_KEY,
  ReasonPresets,
  reasonAccepted,
} from '../domain/reason-presets';
import { SETTINGS_STORE, SettingsStore } from '../domain/settings.store';

const CACHE_MS = 15_000;

export interface ReasonPresetsView {
  presets: ReasonPresets;
  kinds: { kind: PresetKind; label: string; asked: string }[];
  limits: { perKind: number; textMax: number };
}

/** Reason presets (3.2): read by everyone, edited by a Super Admin. */
@Injectable()
export class ReasonPresetsService {
  private readonly logger = new Logger(ReasonPresetsService.name);
  private cached: { value: ReasonPresets; at: number } | null = null;

  constructor(@Inject(SETTINGS_STORE) private readonly store: SettingsStore) {}

  async get(): Promise<ReasonPresets> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.value;
    const value = presetsFromStored(await this.store.read(REASON_PRESETS_KEY));
    this.cached = { value, at: now };
    return value;
  }

  /**
   * Whether `text` is enough for a reason of `kind`: `minChars` long, or one of
   * that kind's presets picked as it is. If the presets cannot be read, length decides.
   */
  async accepts(
    kind: PresetKind,
    text: string | null | undefined,
    minChars: number,
  ): Promise<boolean> {
    if ((text ?? '').trim().length >= minChars) return true;
    try {
      return reasonAccepted(text, minChars, (await this.get())[kind]);
    } catch (err) {
      this.logger.warn(`reason presets unreadable: ${(err as Error).message}`);
      return false;
    }
  }

  async view(): Promise<ReasonPresetsView> {
    return {
      presets: await this.get(),
      kinds: PRESET_KINDS.map((kind) => ({ kind, ...PRESET_KIND_INFO[kind] })),
      limits: { perKind: PRESETS_PER_KIND_MAX, textMax: PRESET_TEXT_MAX },
    };
  }

  /** Each kind given replaces its list (null: back to the defaults). */
  async update(patch: Record<string, unknown>, updatedById: string): Promise<ReasonPresetsView> {
    const current = presetsFromStored(await this.store.read(REASON_PRESETS_KEY));
    const result = applyPresetsPatch(current, patch);
    if (!result.ok) {
      throw new ValidationError(result.message, 'VALIDATION_ERROR').withDetails({
        field: result.field,
      });
    }
    await this.store.write(REASON_PRESETS_KEY, result.value, updatedById);
    this.cached = { value: result.value, at: Date.now() };
    if (result.changed.length) {
      this.logger.log(`reason presets changed by ${updatedById}: ${result.changed.join(', ')}`);
    }
    return this.view();
  }
}
