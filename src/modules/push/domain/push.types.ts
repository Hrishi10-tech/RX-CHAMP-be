/** What a module hands PushService: who it is for and what it says. */
export interface PushMessage {
  recipientId: string;
  /** Lock screens show these: calm, and nothing sensitive. */
  title: string;
  body: string;
  /** What the phone opens on a tap: short strings, no secrets. */
  data?: Record<string, string>;
}

/**
 * NOT_SENT: the flag is off or no credentials are set, so only the row exists.
 * NO_DEVICE: the person has no phone registered.
 * SENT: at least one of their phones took it.
 * FAILED: none did (`error_code` says why).
 */
export type PushSentState = 'NOT_SENT' | 'NO_DEVICE' | 'SENT' | 'FAILED';

export const PUSH_PLATFORMS = ['android', 'ios', 'web'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];
