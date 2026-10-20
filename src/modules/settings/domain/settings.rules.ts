/**
 * Organisation settings (SPEC 1.10; per organisation since 4.0): the Admin's knobs
 * for the 48-hour rule, attendance classes, late starts, quiet hours, the missed
 * End Day auto-close and (4.0) the paid break buffer. Pure: no Nest, no Prisma.
 *
 * The same JSON row (app_settings key `org:<companyId>`) also holds the calendar's
 * week pattern and the input-tracking configuration; those have their own rules
 * (calendar.rules, idle.rules) and are left untouched by these.
 */

export interface AppSettings {
  /** Hours an approver has to decide an item before it is overdue. */
  approvalSlaHours: number;
  /** A Manager with overdue approvals cannot End Day from a 3.1 agent. */
  blockManagerEndDayWhenOverdue: boolean;
  /** Focus at or above this % of expected is a FULL day. */
  fullDayPct: number;
  /** Focus at or above this % of expected (and below full) is a HALF day. */
  halfDayPct: number;
  /** A first Start Day more than this many minutes after the shift start is a late start. */
  lateStartGraceMin: number;
  /** An available hour with fewer active minutes than this is a quiet hour. */
  quietHourActiveMin: number;
  /** This many quiet hours in a month or more: the person "needs a look". */
  quietHoursFlag: number;
  /** An open session is closed this many minutes after the shift ends. */
  autoCloseAfterShiftEndMin: number;
  /** 4.0: paid minutes on top of the scheduled breaks for overruns and quick breaks. */
  breakBufferMin: number;
}

export type SettingKey = keyof AppSettings;

/** The 3.x row in app_settings that held these values (the fallback for organisations). */
export const SETTINGS_KEY = 'org';

/** 4.0: one row per organisation. */
export function orgSettingsKey(companyId: string): string {
  return `org:${companyId}`;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  approvalSlaHours: 48,
  blockManagerEndDayWhenOverdue: true,
  fullDayPct: 80,
  halfDayPct: 40,
  lateStartGraceMin: 10,
  quietHourActiveMin: 20,
  quietHoursFlag: 4,
  autoCloseAfterShiftEndMin: 240,
  breakBufferMin: 10,
});

type IntKey = Exclude<SettingKey, 'blockManagerEndDayWhenOverdue'>;

/** Inclusive bounds of every whole-number setting. */
export const SETTING_BOUNDS: Readonly<Record<IntKey, { min: number; max: number }>> = Object.freeze(
  {
    approvalSlaHours: { min: 12, max: 168 },
    fullDayPct: { min: 1, max: 100 },
    halfDayPct: { min: 1, max: 99 },
    lateStartGraceMin: { min: 0, max: 120 },
    quietHourActiveMin: { min: 1, max: 59 },
    quietHoursFlag: { min: 1, max: 100 },
    autoCloseAfterShiftEndMin: { min: 30, max: 720 },
    breakBufferMin: { min: 0, max: 60 },
  },
);

const LABEL: Record<SettingKey, string> = {
  approvalSlaHours: 'Approval time limit (hours)',
  blockManagerEndDayWhenOverdue: 'Block End Day for managers with overdue approvals',
  fullDayPct: 'Full day (% of expected)',
  halfDayPct: 'Half day (% of expected)',
  lateStartGraceMin: 'Late start grace (minutes)',
  quietHourActiveMin: 'Quiet hour (active minutes)',
  quietHoursFlag: 'Quiet hours before a look',
  autoCloseAfterShiftEndMin: 'Auto-close after shift end (minutes)',
  breakBufferMin: 'Paid break buffer (minutes)',
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

export type PatchResult =
  | { ok: true; value: AppSettings; changed: SettingKey[] }
  | { ok: false; field: SettingKey; message: string };

function isIntKey(key: SettingKey): key is IntKey {
  return key !== 'blockManagerEndDayWhenOverdue';
}

/** Problem with one value, or null when it is valid. */
function problemWith(key: SettingKey, value: unknown): string | null {
  if (!isIntKey(key)) {
    return typeof value === 'boolean' ? null : `${LABEL[key]} must be true or false.`;
  }
  const { min, max } = SETTING_BOUNDS[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return `${LABEL[key]} must be a whole number from ${min} to ${max}.`;
  }
  return null;
}

/**
 * Applies a partial update. Unknown keys are ignored; `undefined` means "leave
 * it". Every given value must be in bounds, and the merged result must keep a
 * full day above a half day. The first problem wins (with its field), in the
 * order of the settings table.
 */
export function applySettingsPatch(
  current: AppSettings,
  patch: Partial<Record<SettingKey, unknown>>,
): PatchResult {
  const next: AppSettings = { ...current };
  const changed: SettingKey[] = [];
  for (const key of SETTING_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    const problem = problemWith(key, value);
    if (problem) return { ok: false, field: key, message: problem };
    if (next[key] !== value) changed.push(key);
    (next as unknown as Record<SettingKey, unknown>)[key] = value;
  }
  if (next.fullDayPct <= next.halfDayPct) {
    const field: SettingKey =
      patch.fullDayPct !== undefined || patch.halfDayPct === undefined
        ? 'fullDayPct'
        : 'halfDayPct';
    return {
      ok: false,
      field,
      message: `A full day (${next.fullDayPct}%) must be more than a half day (${next.halfDayPct}%).`,
    };
  }
  return { ok: true, value: next, changed };
}

/**
 * Reads what is stored, falling back to the default for anything missing or
 * invalid (a hand-edited row can never break the API).
 */
export function settingsFromStored(stored: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  const raw = stored as Record<string, unknown>;
  for (const key of SETTING_KEYS) {
    if (raw[key] !== undefined && problemWith(key, raw[key]) === null) {
      (out as unknown as Record<SettingKey, unknown>)[key] = raw[key];
    }
  }
  if (out.fullDayPct <= out.halfDayPct) {
    out.fullDayPct = DEFAULT_SETTINGS.fullDayPct;
    out.halfDayPct = DEFAULT_SETTINGS.halfDayPct;
  }
  return out;
}
