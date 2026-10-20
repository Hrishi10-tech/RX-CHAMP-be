export const SETTINGS_STORE = Symbol('SETTINGS_STORE');

/** Raw access to app_settings rows (one JSON value per key). */
export interface SettingsStore {
  read(key: string): Promise<unknown | null>;
  write(key: string, value: unknown, updatedById: string | null): Promise<void>;
  /** The organisation a person belongs to (null: none, or unknown). */
  companyOfUser(userId: string): Promise<string | null>;
  /** 4.0: what the input-tracking setting of a person depends on. */
  idleFactsOfUser(userId: string): Promise<{
    companyId: string | null;
    departmentId: string | null;
    idleEnabled: boolean | null;
    idleMinutes: number | null;
  } | null>;
}
