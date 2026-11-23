export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

/**
 * One device's answer. UNREGISTERED: the token is dead, forget it. REJECTED: the
 * provider refused this message. UNAVAILABLE: the provider could not be reached
 * or signed in to.
 */
export type PushDelivery =
  | { ok: true }
  | { ok: false; code: 'UNREGISTERED' | 'REJECTED' | 'UNAVAILABLE' };

/** Who carries a push to a device (FCM in production, a local fake in tests). */
export interface PushProvider {
  /** False until the provider's credentials are set: nothing is attempted then. */
  readonly configured: boolean;
  /** Never throws, and never puts the token or a key in an error or a log line. */
  deliver(deviceToken: string, payload: PushPayload): Promise<PushDelivery>;
}
