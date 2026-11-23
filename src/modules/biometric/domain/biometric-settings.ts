import { GAP_RULES, GapRule, MISSING_CHECKOUT_RULES, MissingCheckoutRule } from './punch';

/**
 * Biometric settings (3.5), one JSON value in app_settings (key `biometric`). The
 * pull adapter's secret (an API token or password) is kept in its own row
 * (`biometric.secret`) and never sent back to a client. Pure.
 */

export const BIOMETRIC_SETTINGS_KEY = 'biometric';
export const BIOMETRIC_SECRET_KEY = 'biometric.secret';
export const BIOMETRIC_PULL_STATE_KEY = 'biometric.pull.state';

export const AUTH_TYPES = ['NONE', 'BEARER', 'TOKEN', 'JWT', 'HEADER', 'BASIC', 'LOGIN'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];
export const TIME_FORMATS = ['AUTO', 'ISO', 'LOCAL', 'EPOCH_S', 'EPOCH_MS'] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];
export const PULL_PRESETS = ['GENERIC', 'BIOTIME'] as const;
export type PullPreset = (typeof PULL_PRESETS)[number];

export interface PullFields {
  code: string;
  time: string;
  direction: string;
  deviceId: string;
  externalId: string;
}

/** A generic HTTP JSON reader for a biometric system's API. */
export interface PullConfig {
  enabled: boolean;
  preset: PullPreset;
  /** GET this URL for punches (http or https). */
  url: string;
  authType: AuthType;
  /** HEADER: the header's name (X-API-Key). */
  authHeader: string;
  /** BASIC and LOGIN: the user name. */
  username: string;
  /** LOGIN: POST { username, password } here and read the token at `tokenPath`. */
  loginUrl: string;
  tokenPath: string;
  /** LOGIN: how the token is sent ("Token", "JWT", "Bearer"). */
  tokenScheme: string;
  /** Query parameters for the window read: from and to. */
  sinceParam: string;
  untilParam: string;
  /** How the window's instants are written in the query. */
  queryTimeFormat: TimeFormat;
  /** Where the list is in the answer (dot path; empty: the answer is the list). */
  listPath: string;
  /** Where the next page's URL is (dot path; empty: one page). */
  nextPath: string;
  fields: PullFields;
  /** How the answer writes the time. */
  timeFormat: TimeFormat;
  /** How the answer writes a check-in and a check-out (anything else: unknown). */
  inWords: string[];
  outWords: string[];
  /** Read every this many minutes, going back this far each time (late syncs). */
  everyMin: number;
  overlapMin: number;
}

export interface BiometricSettings {
  /** SPAN: first punch to last, all counted; PAIRS: in to out, gaps left out. */
  gapRule: GapRule;
  /** A day with no check-out at the cutoff closes at its last punch, or at the shift end. */
  missingCheckout: MissingCheckoutRule;
  /** Punches this close together (seconds) are one punch. */
  duplicateWindowSec: number;
  /** Push: how the connector writes a check-in and a check-out, besides IN and OUT. */
  pushInWords: string[];
  pushOutWords: string[];
  pull: PullConfig;
}

export const BIOTIME_PULL: Omit<PullConfig, 'enabled' | 'url' | 'username'> = {
  preset: 'BIOTIME',
  authType: 'LOGIN',
  authHeader: '',
  loginUrl: '',
  tokenPath: 'token',
  tokenScheme: 'Token',
  sinceParam: 'start_time',
  untilParam: 'end_time',
  queryTimeFormat: 'LOCAL',
  listPath: 'data',
  nextPath: 'next',
  fields: {
    code: 'emp_code',
    time: 'punch_time',
    direction: 'punch_state',
    deviceId: 'terminal_sn',
    externalId: 'id',
  },
  timeFormat: 'LOCAL',
  // BioTime: 0 check-in, 1 check-out, 2 break out, 3 break in, 4 overtime in, 5 overtime out.
  inWords: ['0', '3', '4'],
  outWords: ['1', '2', '5'],
  everyMin: 5,
  overlapMin: 30,
};

export const DEFAULT_PULL: Readonly<PullConfig> = Object.freeze({
  enabled: false,
  preset: 'GENERIC',
  url: '',
  authType: 'NONE',
  authHeader: 'X-API-Key',
  username: '',
  loginUrl: '',
  tokenPath: 'token',
  tokenScheme: 'Bearer',
  sinceParam: 'from',
  untilParam: 'to',
  queryTimeFormat: 'ISO',
  listPath: 'data',
  nextPath: '',
  fields: {
    code: 'code',
    time: 'time',
    direction: 'direction',
    deviceId: 'deviceId',
    externalId: 'id',
  },
  timeFormat: 'AUTO',
  inWords: [],
  outWords: [],
  everyMin: 5,
  overlapMin: 30,
});

export const DEFAULT_BIOMETRIC: Readonly<BiometricSettings> = Object.freeze({
  gapRule: 'SPAN',
  missingCheckout: 'LAST_PUNCH',
  duplicateWindowSec: 60,
  pushInWords: [],
  pushOutWords: [],
  pull: DEFAULT_PULL,
});

export const BIOMETRIC_BOUNDS = Object.freeze({
  duplicateWindowSec: { min: 0, max: 600 },
  everyMin: { min: 1, max: 60 },
  overlapMin: { min: 0, max: 720 },
});

const str = (v: unknown, max = 500): string | null =>
  typeof v === 'string' && v.length <= max ? v.trim() : null;
const words = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length <= 20 && v.every((w) => typeof w === 'string' && w.length <= 30)
    ? v.map((w: string) => w.trim()).filter(Boolean)
    : null;
const wholeIn = (v: unknown, b: { min: number; max: number }): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= b.min && v <= b.max;

function pullFrom(raw: unknown): PullConfig {
  const out: PullConfig = { ...DEFAULT_PULL, fields: { ...DEFAULT_PULL.fields } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.preset === 'string' && (PULL_PRESETS as readonly string[]).includes(r.preset)) {
    out.preset = r.preset as PullPreset;
  }
  if (typeof r.authType === 'string' && (AUTH_TYPES as readonly string[]).includes(r.authType)) {
    out.authType = r.authType as AuthType;
  }
  for (const k of [
    'url',
    'authHeader',
    'username',
    'loginUrl',
    'tokenPath',
    'tokenScheme',
    'sinceParam',
    'untilParam',
    'listPath',
    'nextPath',
  ] as const) {
    const v = str(r[k], k === 'url' || k === 'loginUrl' ? 2000 : 200);
    if (v !== null) out[k] = v;
  }
  for (const k of ['timeFormat', 'queryTimeFormat'] as const) {
    const v = r[k];
    if (typeof v === 'string' && (TIME_FORMATS as readonly string[]).includes(v))
      out[k] = v as TimeFormat;
  }
  if (r.fields && typeof r.fields === 'object') {
    const f = r.fields as Record<string, unknown>;
    for (const k of ['code', 'time', 'direction', 'deviceId', 'externalId'] as const) {
      const v = str(f[k], 120);
      if (v !== null) out.fields[k] = v;
    }
  }
  const inW = words(r.inWords);
  if (inW) out.inWords = inW;
  const outW = words(r.outWords);
  if (outW) out.outWords = outW;
  if (wholeIn(r.everyMin, BIOMETRIC_BOUNDS.everyMin)) out.everyMin = r.everyMin;
  if (wholeIn(r.overlapMin, BIOMETRIC_BOUNDS.overlapMin)) out.overlapMin = r.overlapMin;
  return out;
}

/** What is stored, made whole: anything unreadable falls back to its default. */
export function biometricFromStored(raw: unknown): BiometricSettings {
  const out: BiometricSettings = {
    ...DEFAULT_BIOMETRIC,
    pull: pullFrom(undefined),
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.gapRule === 'string' && (GAP_RULES as readonly string[]).includes(r.gapRule)) {
    out.gapRule = r.gapRule as GapRule;
  }
  if (
    typeof r.missingCheckout === 'string' &&
    (MISSING_CHECKOUT_RULES as readonly string[]).includes(r.missingCheckout)
  ) {
    out.missingCheckout = r.missingCheckout as MissingCheckoutRule;
  }
  if (wholeIn(r.duplicateWindowSec, BIOMETRIC_BOUNDS.duplicateWindowSec)) {
    out.duplicateWindowSec = r.duplicateWindowSec;
  }
  const inW = words(r.pushInWords);
  if (inW) out.pushInWords = inW;
  const outW = words(r.pushOutWords);
  if (outW) out.pushOutWords = outW;
  out.pull = pullFrom(r.pull);
  return out;
}

const PULL_STRINGS = [
  'url',
  'authHeader',
  'username',
  'loginUrl',
  'tokenPath',
  'tokenScheme',
  'sinceParam',
  'untilParam',
  'listPath',
  'nextPath',
] as const;

/** The first thing wrong with a pull change, or null. */
function pullProblem(p: Record<string, unknown>): { field: string; message: string } | null {
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    if (k === 'enabled') {
      if (typeof v !== 'boolean') return { field: k, message: 'enabled must be on or off.' };
    } else if (k === 'preset') {
      if (typeof v !== 'string' || !(PULL_PRESETS as readonly string[]).includes(v)) {
        return { field: k, message: 'Pick GENERIC or BIOTIME.' };
      }
    } else if (k === 'authType') {
      if (typeof v !== 'string' || !(AUTH_TYPES as readonly string[]).includes(v)) {
        return { field: k, message: `Pick one of ${AUTH_TYPES.join(', ')}.` };
      }
    } else if (k === 'timeFormat' || k === 'queryTimeFormat') {
      if (typeof v !== 'string' || !(TIME_FORMATS as readonly string[]).includes(v)) {
        return { field: k, message: `Pick one of ${TIME_FORMATS.join(', ')}.` };
      }
    } else if ((PULL_STRINGS as readonly string[]).includes(k)) {
      const max = k === 'url' || k === 'loginUrl' ? 2000 : 200;
      if (typeof v !== 'string' || v.length > max) {
        return { field: k, message: `${k} must be text of at most ${max} characters.` };
      }
      if ((k === 'url' || k === 'loginUrl') && v.trim() && !/^https?:\/\//i.test(v.trim())) {
        return { field: k, message: 'A URL must start with http:// or https://.' };
      }
    } else if (k === 'fields') {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        return { field: k, message: 'fields must be an object.' };
      for (const [f, name] of Object.entries(v as Record<string, unknown>)) {
        if (!['code', 'time', 'direction', 'deviceId', 'externalId'].includes(f)) {
          return { field: `fields.${f}`, message: `${f} is not a field the pull maps.` };
        }
        if (typeof name !== 'string' || name.length > 120) {
          return { field: `fields.${f}`, message: 'A field is a path of at most 120 characters.' };
        }
      }
    } else if (k === 'inWords' || k === 'outWords') {
      if (!words(v)) return { field: k, message: 'Give up to 20 words of up to 30 characters.' };
    } else if (k === 'everyMin' || k === 'overlapMin') {
      const b = BIOMETRIC_BOUNDS[k];
      if (!wholeIn(v, b))
        return { field: k, message: `${k} must be a whole number from ${b.min} to ${b.max}.` };
    } else {
      return { field: k, message: `${k} is not a pull setting.` };
    }
  }
  return null;
}

export type BiometricPatchResult =
  | { ok: true; value: BiometricSettings; changed: string[] }
  | { ok: false; field: string; message: string };

/** A partial change; `pull` may be partial too. Unknown keys are refused. */
export function applyBiometricPatch(
  current: BiometricSettings,
  patch: Record<string, unknown>,
): BiometricPatchResult {
  const next: BiometricSettings = {
    ...current,
    pull: { ...current.pull, fields: { ...current.pull.fields } },
  };
  const changed: string[] = [];
  const known = new Set([
    'gapRule',
    'missingCheckout',
    'duplicateWindowSec',
    'pushInWords',
    'pushOutWords',
    'pull',
  ]);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!known.has(key))
      return { ok: false, field: key, message: `${key} is not a biometric setting.` };
    if (key === 'gapRule') {
      if (typeof value !== 'string' || !(GAP_RULES as readonly string[]).includes(value)) {
        return { ok: false, field: key, message: 'Pick SPAN or PAIRS.' };
      }
      next.gapRule = value as GapRule;
    } else if (key === 'missingCheckout') {
      if (
        typeof value !== 'string' ||
        !(MISSING_CHECKOUT_RULES as readonly string[]).includes(value)
      ) {
        return { ok: false, field: key, message: 'Pick LAST_PUNCH or SHIFT_END.' };
      }
      next.missingCheckout = value as MissingCheckoutRule;
    } else if (key === 'duplicateWindowSec') {
      const b = BIOMETRIC_BOUNDS.duplicateWindowSec;
      if (!wholeIn(value, b)) {
        return {
          ok: false,
          field: key,
          message: `Duplicate window must be ${b.min} to ${b.max} seconds.`,
        };
      }
      next.duplicateWindowSec = value;
    } else if (key === 'pushInWords' || key === 'pushOutWords') {
      const w = words(value);
      if (!w)
        return { ok: false, field: key, message: 'Give up to 20 words of up to 30 characters.' };
      next[key] = w;
    } else if (key === 'pull') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, field: key, message: 'pull must be an object.' };
      }
      const p = value as Record<string, unknown>;
      const problem = pullProblem(p);
      if (problem) return { ok: false, field: `pull.${problem.field}`, message: problem.message };
      let base: PullConfig = { ...next.pull, fields: { ...next.pull.fields } };
      // Choosing the BioTime preset fills in its mapping (the URL and sign-in stay).
      if (p.preset === 'BIOTIME' && current.pull.preset !== 'BIOTIME') {
        base = { ...base, ...BIOTIME_PULL, fields: { ...BIOTIME_PULL.fields } };
      }
      const merged = pullFrom({
        ...base,
        ...p,
        fields: { ...base.fields, ...((p.fields as Record<string, unknown>) ?? {}) },
      });
      if (merged.enabled && !merged.url) {
        return {
          ok: false,
          field: 'pull.url',
          message: 'Give the URL to read punches from before switching the pull on.',
        };
      }
      if (merged.enabled && merged.authType === 'LOGIN' && !merged.loginUrl) {
        return {
          ok: false,
          field: 'pull.loginUrl',
          message: 'Give the sign-in URL the token comes from.',
        };
      }
      next.pull = merged;
    }
    if (
      JSON.stringify((next as unknown as Record<string, unknown>)[key]) !==
      JSON.stringify((current as unknown as Record<string, unknown>)[key])
    ) {
      changed.push(key);
    }
  }
  return { ok: true, value: next, changed };
}
