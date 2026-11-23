/**
 * Reason presets (3.2): the quick answers offered next to every comment box, one
 * list per kind of comment, edited by a Super Admin. Picking a preset fills the box;
 * the person can still type their own words. Stored as one JSON value
 * (app_settings key `reasonPresets`); a kind never saved shows its defaults.
 */

export const REASON_PRESETS_KEY = 'reasonPresets';

export const PRESET_KINDS = [
  'LATE_DAY_START',
  'BREAK_EARLY',
  'BREAK_LATE',
  'BREAK_SKIP',
  'SKIP_COMMENT',
  'BREAK_OVERRUN',
  'MEETING_AGENDA',
  'DECISION_NOTE',
  'LEAVE_REASON',
  'WFH_REASON',
  'COMPOFF_REASON',
] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];

export const PRESET_KIND_INFO: Record<PresetKind, { label: string; asked: string }> = {
  LATE_DAY_START: {
    label: 'Late start of the day',
    asked: 'Why are you starting late? (Start Day after the late-start grace)',
  },
  BREAK_EARLY: {
    label: 'Break started early',
    asked: 'Why are you starting early? (before the ring)',
  },
  BREAK_LATE: {
    label: 'Break started late',
    asked: 'Why are you starting late? (after the ring stopped)',
  },
  BREAK_SKIP: { label: 'Skipping a break', asked: 'Why are you skipping this break?' },
  SKIP_COMMENT: {
    label: 'Comment on an auto-skipped break',
    asked: 'Why was it skipped? (the window closed with no break)',
  },
  BREAK_OVERRUN: {
    label: 'Back late from a break',
    asked: 'Why were you late back?',
  },
  MEETING_AGENDA: { label: 'Meeting agenda', asked: 'What is the meeting about?' },
  DECISION_NOTE: {
    label: 'Manager note on a decision',
    asked: 'A note to the person when approving or rejecting',
  },
  LEAVE_REASON: { label: 'Reason for leave', asked: 'Why are you taking leave?' },
  WFH_REASON: { label: 'Reason for work from home', asked: 'Why work from home that day?' },
  COMPOFF_REASON: {
    label: 'Comp off claim',
    asked: 'What did you work on that day? (claiming comp off)',
  },
};

export const DEFAULT_REASON_PRESETS: Record<PresetKind, string[]> = {
  LATE_DAY_START: [
    'Traffic',
    'Public transport delay',
    'Doctor appointment',
    'Power or internet outage',
    'Agreed with my manager',
  ],
  BREAK_EARLY: ['A client call starts soon', 'A meeting starts soon', 'Finished my task early'],
  BREAK_LATE: ['On a client call', 'In a meeting', 'Finishing an urgent task'],
  BREAK_SKIP: ['Client call', 'Deadline', 'Not needed today', 'Already rested'],
  SKIP_COMMENT: ['On a client call', 'In a meeting', 'Deadline', 'Forgot to take it'],
  BREAK_OVERRUN: [
    'A call ran over',
    'Queue at the canteen',
    'Helped a colleague',
    'Lost track of time',
  ],
  MEETING_AGENDA: ['Client call', 'Team stand-up', 'Review meeting', 'Training'],
  DECISION_NOTE: [
    'Approved, thanks for the note',
    'Please take breaks on time',
    'Let us talk about this',
  ],
  LEAVE_REASON: [
    'Unwell',
    'Family function',
    'Personal work',
    'Medical appointment',
    'Travel',
    'Festival',
  ],
  WFH_REASON: [
    'Delivery or repair at home',
    'Mild illness, can work',
    'Heavy rain or transport strike',
    'Family needs me at home',
    'Focused work on a deadline',
  ],
  COMPOFF_REASON: ['Release or deployment', 'Client visit', 'Audit', 'Urgent support', 'Event'],
};

export const PRESETS_PER_KIND_MAX = 12;
export const PRESET_TEXT_MAX = 80;

export type ReasonPresets = Record<PresetKind, string[]>;

function cleanList(list: unknown): string[] | null {
  if (!Array.isArray(list)) return null;
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim().replace(/\s+/g, ' ');
    if (!t || out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    out.push(t);
  }
  return out;
}

/** The stored value with defaults filled in (anything malformed falls back). */
export function presetsFromStored(stored: unknown): ReasonPresets {
  const src = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const out = {} as ReasonPresets;
  for (const kind of PRESET_KINDS) {
    const list = cleanList(src[kind]);
    out[kind] = list
      ? list.slice(0, PRESETS_PER_KIND_MAX).map((t) => t.slice(0, PRESET_TEXT_MAX))
      : [...DEFAULT_REASON_PRESETS[kind]];
  }
  return out;
}

export type PresetsPatchResult =
  | { ok: true; value: ReasonPresets; changed: PresetKind[] }
  | { ok: false; field: string; message: string };

/** Applies a partial update: each kind given replaces that kind's list. */
export function applyPresetsPatch(
  current: ReasonPresets,
  patch: Record<string, unknown>,
): PresetsPatchResult {
  const next: ReasonPresets = { ...current };
  const changed: PresetKind[] = [];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(PRESET_KINDS as readonly string[]).includes(key)) {
      return { ok: false, field: key, message: `Unknown preset list: ${key}.` };
    }
    const kind = key as PresetKind;
    if (value === null) {
      next[kind] = [...DEFAULT_REASON_PRESETS[kind]];
      changed.push(kind);
      continue;
    }
    if (!Array.isArray(value)) {
      return {
        ok: false,
        field: key,
        message: `${PRESET_KIND_INFO[kind].label}: send a list of texts.`,
      };
    }
    if (value.some((v) => typeof v !== 'string')) {
      return {
        ok: false,
        field: key,
        message: `${PRESET_KIND_INFO[kind].label}: every preset is a text.`,
      };
    }
    const list = cleanList(value) ?? [];
    if (list.length > PRESETS_PER_KIND_MAX) {
      return {
        ok: false,
        field: key,
        message: `${PRESET_KIND_INFO[kind].label}: at most ${PRESETS_PER_KIND_MAX} presets.`,
      };
    }
    const long = list.find((t) => t.length > PRESET_TEXT_MAX);
    if (long) {
      return {
        ok: false,
        field: key,
        message: `${PRESET_KIND_INFO[kind].label}: a preset can be at most ${PRESET_TEXT_MAX} characters.`,
      };
    }
    next[kind] = list;
    changed.push(kind);
  }
  return { ok: true, value: next, changed };
}

/** A text as presets are compared: trimmed, single spaces, case ignored. */
function presetKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Whether `text` is one of `list`, picked as offered (case and spacing aside). */
export function isPresetText(
  list: readonly string[] | null | undefined,
  text: string | null | undefined,
): boolean {
  if (!list?.length || !text) return false;
  const key = presetKey(text);
  return key.length > 0 && list.some((p) => presetKey(p) === key);
}

/**
 * Whether a reason is enough: at least `minChars` long, or one of the presets the
 * Super Admin offers for it, picked as it is. A preset is an answer the
 * organisation chose, so a short one ("Traffic") counts even under a 10-character
 * minimum.
 */
export function reasonAccepted(
  text: string | null | undefined,
  minChars: number,
  presets?: readonly string[] | null,
): boolean {
  const t = (text ?? '').trim();
  return t.length >= minChars || isPresetText(presets, t);
}
