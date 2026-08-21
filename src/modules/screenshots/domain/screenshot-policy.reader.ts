export const SCREENSHOT_POLICY_READER = Symbol('SCREENSHOT_POLICY_READER');

/**
 * Reads the per-user switch that decides whether automatic screenshots are taken.
 * A manager or admin owns the setting (it lives on the user), but the agent is the
 * one told about it, so the upload path checks it too: a capture already in flight
 * when the switch is turned off must not be stored.
 *
 * Only AUTO captures are subject to it — a manual capture requested by a manager is
 * always allowed through.
 *
 * Its own port so the screenshots module doesn't depend on the users module.
 */
export interface ScreenshotPolicyReader {
  /** False when a manager has switched this user's automatic screenshots off. */
  isAutoEnabled(userId: string): Promise<boolean>;
}
