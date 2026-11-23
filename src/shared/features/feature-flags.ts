/**
 * Release feature flags (3.6).
 *
 * Every Phase 2 feature of the November 2026 release, and every part blocked on something
 * outside this repository (the desktop agent build, phone push credentials), sits behind
 * one of these flags. The default is the state the release ships with: on only when every
 * acceptance check of the feature passed. A deployment can override any flag with
 * `FEATURE_<NAME>=on|off` (for example `FEATURE_MESSAGING=off`), read once at boot.
 *
 * A flag that is off hides the feature's endpoints (404 FEATURE_OFF) and the clients hide
 * its screens (they read `GET /features`). Turning a flag off never deletes data.
 */
export const FEATURE_FLAGS = {
  /** 2.1 Messaging: one-to-one text, images and voice notes for everyone. */
  messaging: { env: 'FEATURE_MESSAGING', default: false },
  /** 2.2 Mobile parity for managers and admins (the phone app reads this flag). */
  mobileParity: { env: 'FEATURE_MOBILE_PARITY', default: false },
  /** 2.3 AI settings: the Claude API key, model routing and usage (Super Admin). */
  aiSettings: { env: 'FEATURE_AI_SETTINGS', default: false },
  /** 2.4 AI Insights daily summaries (needs 2.7). */
  aiInsights: { env: 'FEATURE_AI_INSIGHTS', default: false },
  /** 2.5 AI Insights chat (needs 2.7). */
  aiChat: { env: 'FEATURE_AI_CHAT', default: false },
  /** 2.6 Data-transfer red flags (needs 2.7). */
  redFlags: { env: 'FEATURE_RED_FLAGS', default: false },
  /** 2.7 Data handling: capture retention, AI exclusions, the monitoring notice. */
  dataHandling: { env: 'FEATURE_DATA_HANDLING', default: false },
  /** 1.1 to 1.5 and the agent parts of 1.8, 1.9, 2.1: the redesigned desktop agent. */
  agentCalmUi: { env: 'FEATURE_AGENT_CALM_UI', default: false },
  /** Phone push notifications (needs Firebase credentials). */
  mobilePush: { env: 'FEATURE_MOBILE_PUSH', default: false },
} as const;

export type FeatureName = keyof typeof FEATURE_FLAGS;

export const FEATURE_NAMES = Object.keys(FEATURE_FLAGS) as FeatureName[];

/** Flags that may be on only while `dataHandling` is on (brief, How to run, rule 11). */
export const NEEDS_DATA_HANDLING: readonly FeatureName[] = ['aiInsights', 'aiChat', 'redFlags'];

/** `on`/`true`/`1` is on, `off`/`false`/`0` is off, anything else (or unset) is the default. */
export function parseFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(value)) return true;
  if (['off', 'false', '0', 'no'].includes(value)) return false;
  return fallback;
}

/**
 * The effective state of every flag from an environment. A feature that needs data
 * handling is reported off while data handling is off, whatever its own setting says.
 */
export function resolveFlags(
  env: Record<string, string | undefined>,
): Record<FeatureName, boolean> {
  const flags = {} as Record<FeatureName, boolean>;
  for (const name of FEATURE_NAMES) {
    const def = FEATURE_FLAGS[name];
    flags[name] = parseFlag(env[def.env], def.default);
  }
  if (!flags.dataHandling) {
    for (const name of NEEDS_DATA_HANDLING) flags[name] = false;
  }
  return flags;
}
