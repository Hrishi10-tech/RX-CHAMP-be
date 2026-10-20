/**
 * Input (away) tracking configuration (docs/4.0/SPEC.md 2.5). Pure: no Nest, no
 * Prisma. Stored in the organisation's settings row (app_settings `org:<id>`)
 * under the keys `idleDefaultEnabled`, `idleDefaultMinutes`, `idleReasons` and
 * `departmentIdle`; per person on users.idle_enabled / idle_minutes.
 */

export type AwayReasonKind = 'BREAK' | 'THINKING' | 'MEETING' | 'HARDWARE' | 'OTHER' | 'CUSTOM';

export interface AwayReason {
  key: string;
  label: string;
  kind: AwayReasonKind;
  builtIn: boolean;
}

export interface DepartmentIdle {
  /** null: the organisation default. */
  enabled: boolean | null;
  /** null: the organisation default. */
  minutes: number | null;
  /** null: the default set (BREAK, THINKING, MEETING, OTHER). */
  reasonKeys: string[] | null;
}

export interface OrgIdleSettings {
  defaultEnabled: boolean;
  defaultMinutes: number;
  reasons: AwayReason[];
  departments: Record<string, DepartmentIdle>;
}

/** The fields the agent asks for each kind (and the server requires). */
export const REASON_FIELDS: Record<AwayReasonKind, string[]> = {
  BREAK: [],
  THINKING: ['comment'],
  MEETING: ['participants', 'comment', 'momSender'],
  HARDWARE: ['comment'],
  OTHER: ['comment'],
  CUSTOM: ['comment'],
};

export const BUILT_IN_REASONS: readonly AwayReason[] = Object.freeze([
  { key: 'BREAK', label: 'Took a break', kind: 'BREAK', builtIn: true },
  { key: 'THINKING', label: 'Thinking', kind: 'THINKING', builtIn: true },
  { key: 'MEETING', label: 'Short meeting', kind: 'MEETING', builtIn: true },
  { key: 'HARDWARE', label: 'Working on hardware', kind: 'HARDWARE', builtIn: true },
  { key: 'OTHER', label: 'Other work', kind: 'OTHER', builtIn: true },
]);

export const DEFAULT_REASON_KEYS: readonly string[] = Object.freeze([
  'BREAK',
  'THINKING',
  'MEETING',
  'OTHER',
]);

export const IDLE_MINUTES = { min: 2, max: 60 } as const;
export const IDLE_DEFAULT_MINUTES = 5;
export const REASON_LABEL = { min: 2, max: 40 } as const;
export const MAX_CUSTOM_REASONS = 20;

/** Keys of custom reasons: `C_<slug>` (server-made) or `CUSTOM_<SLUG>` (made by the portal). */
export const CUSTOM_KEY = /^(C|CUSTOM)_[A-Za-z0-9_-]{1,40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validMinutes(v: unknown): v is number {
  return (
    typeof v === 'number' && Number.isInteger(v) && v >= IDLE_MINUTES.min && v <= IDLE_MINUTES.max
  );
}

function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= REASON_LABEL.min && t.length <= REASON_LABEL.max ? t : null;
}

/** The reasons list from what is stored: every built-in (label possibly renamed), then valid customs. */
export function reasonsFromStored(stored: unknown): AwayReason[] {
  const list = Array.isArray(stored) ? stored : [];
  const byKey = new Map<string, Record<string, unknown>>();
  for (const r of list) if (isObject(r) && typeof r.key === 'string') byKey.set(r.key, r);
  const out: AwayReason[] = BUILT_IN_REASONS.map((b) => ({
    ...b,
    label: cleanLabel(byKey.get(b.key)?.label) ?? b.label,
  }));
  for (const r of list) {
    if (!isObject(r) || typeof r.key !== 'string') continue;
    if (BUILT_IN_REASONS.some((b) => b.key === r.key)) continue;
    if (!CUSTOM_KEY.test(r.key)) continue;
    const label = cleanLabel(r.label);
    if (!label || out.some((o) => o.key === r.key)) continue;
    out.push({ key: r.key, label, kind: 'CUSTOM', builtIn: false });
    if (out.length >= BUILT_IN_REASONS.length + MAX_CUSTOM_REASONS) break;
  }
  return out;
}

/** The organisation's input-tracking settings from its settings row (defaults for anything missing). */
export function idleFromStored(raw: Record<string, unknown>): OrgIdleSettings {
  const reasons = reasonsFromStored(raw.idleReasons);
  const known = new Set(reasons.map((r) => r.key));
  const departments: Record<string, DepartmentIdle> = {};
  if (isObject(raw.departmentIdle)) {
    for (const [id, v] of Object.entries(raw.departmentIdle)) {
      if (!isObject(v)) continue;
      departments[id] = {
        enabled: typeof v.enabled === 'boolean' ? v.enabled : null,
        minutes: validMinutes(v.minutes) ? v.minutes : null,
        reasonKeys: Array.isArray(v.reasonKeys)
          ? v.reasonKeys.filter((k): k is string => typeof k === 'string' && known.has(k))
          : null,
      };
    }
  }
  return {
    defaultEnabled: typeof raw.idleDefaultEnabled === 'boolean' ? raw.idleDefaultEnabled : false,
    defaultMinutes: validMinutes(raw.idleDefaultMinutes)
      ? raw.idleDefaultMinutes
      : IDLE_DEFAULT_MINUTES,
    reasons,
    departments,
  };
}

/** What the agent gets in GET /workday/me/today → config.idle. */
export interface EffectiveIdle {
  enabled: boolean;
  minutes: number;
  reasons: { key: string; label: string; kind: AwayReasonKind; fields: string[] }[];
}

/**
 * The person's effective setting: their own override, else their department's,
 * else the organisation default. The reasons are the department's chosen set
 * (default set when none), in the organisation's order; BREAK is always offered.
 */
export function effectiveIdle(
  org: OrgIdleSettings,
  departmentId: string | null,
  person: { idleEnabled: boolean | null; idleMinutes: number | null },
): EffectiveIdle {
  const dept = departmentId ? org.departments[departmentId] : undefined;
  const enabled = person.idleEnabled ?? dept?.enabled ?? org.defaultEnabled;
  const minutes = person.idleMinutes ?? dept?.minutes ?? org.defaultMinutes;
  const keys = new Set(dept?.reasonKeys ?? DEFAULT_REASON_KEYS);
  keys.add('BREAK');
  const reasons = org.reasons
    .filter((r) => keys.has(r.key))
    .map((r) => ({ key: r.key, label: r.label, kind: r.kind, fields: REASON_FIELDS[r.kind] }));
  return { enabled, minutes, reasons };
}

// ---- Validation for the input-tracking endpoints (SPEC 5.5) ---------------------

export const MAX_DEPARTMENT_REASON_KEYS = 25;

/** Whole minutes inside the allowed range (2..60). */
export function isIdleMinutes(v: unknown): v is number {
  return validMinutes(v);
}

export interface IdleRuleProblem {
  ok: false;
  code: string;
  message: string;
  field: string;
}

export type IdleRuleResult<T> = { ok: true; value: T } | IdleRuleProblem;

function problem(code: string, message: string, field: string): IdleRuleProblem {
  return { ok: false, code, message, field };
}

/** A label as stored: trimmed, inner whitespace collapsed. */
export function normaliseReasonLabel(v: string): string {
  return (v ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * The key for a new custom reason: `C_` + the label in capitals with underscores
 * ("Lab bench work" -> C_LAB_BENCH_WORK), made unique against `taken` with _2, _3...
 */
export function customReasonKey(label: string, taken: ReadonlySet<string>): string {
  const slug = normaliseReasonLabel(label)
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9\s_-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 32);
  const base = `C_${slug || 'REASON'}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface ReasonInput {
  /**
   * An existing reason's key, a new custom key made by the portal (CUSTOM_<SLUG>
   * or C_<SLUG>), or omitted (null) for a new custom reason the server names.
   */
  key?: string | null;
  label: string;
}

/**
 * The reasons list after an edit. Built-ins stay (they may only be renamed),
 * existing custom reasons keep their key, a new custom reason keeps the key the
 * portal gave it (CUSTOM_KEY shape) or gets a generated C_ key, other unknown
 * keys are refused, labels are 2..40 characters and unique ignoring case, and
 * there are at most 20 custom reasons. Built-ins come first, then customs in the
 * order given.
 */
export function applyReasonsUpdate(
  current: readonly AwayReason[],
  incoming: readonly ReasonInput[],
): IdleRuleResult<AwayReason[]> {
  const known = new Map(current.map((r) => [r.key, r] as const));
  const seenKeys = new Set<string>();
  const seenLabels = new Set<string>();
  const builtIns = new Map<string, AwayReason>();
  const customs: AwayReason[] = [];
  const pendingNew: string[] = [];

  for (let i = 0; i < incoming.length; i++) {
    const item = incoming[i];
    const field = `reasons[${i}]`;
    const label = normaliseReasonLabel(typeof item?.label === 'string' ? item.label : '');
    if (label.length < REASON_LABEL.min || label.length > REASON_LABEL.max) {
      return problem(
        'REASON_LABEL',
        `Each reason needs a label of ${REASON_LABEL.min} to ${REASON_LABEL.max} characters.`,
        `${field}.label`,
      );
    }
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      return problem(
        'REASON_DUPLICATE',
        `Two reasons are called "${label}". Give each its own name.`,
        `${field}.label`,
      );
    }
    seenLabels.add(labelKey);

    const key = typeof item?.key === 'string' && item.key.trim() ? item.key.trim() : null;
    if (key === null) {
      pendingNew.push(label);
      continue;
    }
    if (seenKeys.has(key)) {
      return problem('REASON_DUPLICATE', `The reason ${key} appears twice.`, `${field}.key`);
    }
    seenKeys.add(key);
    const builtIn = BUILT_IN_REASONS.find((b) => b.key === key);
    if (builtIn) {
      builtIns.set(key, { ...builtIn, label });
      continue;
    }
    const existing = known.get(key);
    // A key the server does not know yet is accepted only in the custom shape the
    // portal makes (C_... or CUSTOM_...); anything else is refused.
    if ((!existing && !CUSTOM_KEY.test(key)) || existing?.builtIn) {
      return problem(
        'REASON_UNKNOWN',
        'That reason does not exist any more. Reload the page and try again.',
        `${field}.key`,
      );
    }
    customs.push({ key, label, kind: 'CUSTOM', builtIn: false });
  }

  const missing = BUILT_IN_REASONS.filter((b) => !builtIns.has(b.key));
  if (missing.length) {
    const names = missing.map((m) => current.find((c) => c.key === m.key)?.label ?? m.label);
    return problem(
      'REASON_BUILT_IN',
      `Built-in reasons cannot be removed (${names.join(', ')}). You can rename them.`,
      'reasons',
    );
  }

  if (customs.length + pendingNew.length > MAX_CUSTOM_REASONS) {
    return problem(
      'TOO_MANY_REASONS',
      `You can have up to ${MAX_CUSTOM_REASONS} custom reasons.`,
      'reasons',
    );
  }

  // New keys never reuse a key in use now or in the old list, so a department's
  // choice can never silently point at a different reason.
  const taken = new Set<string>([...current.map((r) => r.key), ...seenKeys]);
  for (const label of pendingNew) {
    const key = customReasonKey(label, taken);
    taken.add(key);
    customs.push({ key, label, kind: 'CUSTOM', builtIn: false });
  }

  const ordered = BUILT_IN_REASONS.map((b) => builtIns.get(b.key)!);
  return { ok: true, value: [...ordered, ...customs] };
}

export interface DepartmentIdleInput {
  enabled?: boolean | null;
  minutes?: number | null;
  reasonKeys?: string[] | null;
}

/** A department's override, checked against the organisation's reasons. Missing = null. */
export function validateDepartmentIdle(
  input: DepartmentIdleInput,
  reasons: readonly AwayReason[],
): IdleRuleResult<DepartmentIdle> {
  const enabled = input.enabled ?? null;
  if (enabled !== null && typeof enabled !== 'boolean') {
    return problem('VALIDATION_ERROR', 'enabled must be true, false or null.', 'enabled');
  }
  const minutes = input.minutes ?? null;
  if (minutes !== null && !validMinutes(minutes)) {
    return problem(
      'VALIDATION_ERROR',
      `Minutes must be a whole number from ${IDLE_MINUTES.min} to ${IDLE_MINUTES.max}.`,
      'minutes',
    );
  }
  const raw = input.reasonKeys ?? null;
  let reasonKeys: string[] | null = null;
  if (raw !== null) {
    if (!Array.isArray(raw) || raw.some((k) => typeof k !== 'string')) {
      return problem(
        'VALIDATION_ERROR',
        'reasonKeys must be a list of reason keys or null.',
        'reasonKeys',
      );
    }
    if (raw.length > MAX_DEPARTMENT_REASON_KEYS) {
      return problem('VALIDATION_ERROR', 'Too many reasons chosen.', 'reasonKeys');
    }
    const known = new Set(reasons.map((r) => r.key));
    const unknown = raw.filter((k) => !known.has(k));
    if (unknown.length) {
      return problem(
        'REASON_UNKNOWN',
        `Unknown reason ${unknown[0]}. Reload the page and try again.`,
        'reasonKeys',
      );
    }
    const wanted = new Set(raw);
    // Stored in the organisation's order so every reader shows the same order.
    reasonKeys = reasons.map((r) => r.key).filter((k) => wanted.has(k));
  }
  return { ok: true, value: { enabled, minutes, reasonKeys } };
}

/** True when a department follows the organisation in every respect (no entry needed). */
export function isDefaultDepartmentIdle(d: DepartmentIdle): boolean {
  return d.enabled === null && d.minutes === null && d.reasonKeys === null;
}

/** The reasons as stored in the settings row. */
export function storedReasons(
  reasons: readonly AwayReason[],
): { key: string; label: string; kind: AwayReasonKind }[] {
  return reasons.map((r) => ({ key: r.key, label: r.label, kind: r.kind }));
}
