export const SETTINGS_STORE = Symbol('SETTINGS_STORE');

/** Raw access to app_settings rows (one JSON value per key). */
export interface SettingsStore {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown, updatedById: string | null): Promise<void>;
}
