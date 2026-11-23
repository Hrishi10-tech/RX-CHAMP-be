import { createSign } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PushDelivery, PushPayload, PushProvider } from '../domain/push-provider';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://fcm.googleapis.com';
const TIMEOUT_MS = 10_000;
/** An access token is renewed this long before it runs out. */
const RENEW_EARLY_MS = 60_000;
const ASSERTION_TTL_SEC = 3600;

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

/** The service account and endpoints (AppConfig `push.fcm`, from the FCM_* settings). */
export interface FcmSettings {
  projectId: string;
  clientEmail: string;
  /** PEM; literal `\n` (an env file keeps the key on one line) is read as a line break. */
  privateKey: string;
  /** Empty: Google's own. Tests point these at a local fake. */
  tokenUrl: string;
  apiUrl: string;
}

/**
 * Firebase Cloud Messaging over HTTP v1, signed in with a service account
 * (FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY). FCM_TOKEN_URL and FCM_API_URL
 * point it at a local fake in tests; production leaves them unset.
 *
 * Log lines carry a status or a short code only. The device token, the private key
 * and the provider's answers (which can echo a token) never reach a log.
 */
export class FcmHttpProvider implements PushProvider {
  private readonly logger = new Logger(FcmHttpProvider.name);
  private readonly projectId: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;
  private readonly tokenUrl: string;
  private readonly apiUrl: string;
  private access: { token: string; expiresAt: number } | null = null;

  constructor(settings: Partial<FcmSettings>) {
    this.projectId = (settings.projectId ?? '').trim();
    this.clientEmail = (settings.clientEmail ?? '').trim();
    // Env files keep the key on one line with literal \n.
    this.privateKey = (settings.privateKey ?? '').replace(/\\n/g, '\n').trim();
    this.tokenUrl = (settings.tokenUrl ?? '').trim() || TOKEN_URL;
    this.apiUrl = ((settings.apiUrl ?? '').trim() || API_URL).replace(/\/+$/, '');
  }

  get configured(): boolean {
    return !!this.projectId && !!this.clientEmail && !!this.privateKey;
  }

  async deliver(deviceToken: string, payload: PushPayload): Promise<PushDelivery> {
    try {
      const first = await this.post(deviceToken, payload);
      if (first !== 'AUTH') return first;
      // The access token was refused: sign in again once.
      this.access = null;
      const second = await this.post(deviceToken, payload);
      return second === 'AUTH' ? { ok: false, code: 'UNAVAILABLE' } : second;
    } catch (err) {
      this.logger.warn(`FCM could not be reached (${(err as Error).name})`);
      return { ok: false, code: 'UNAVAILABLE' };
    }
  }

  private async post(deviceToken: string, payload: PushPayload): Promise<PushDelivery | 'AUTH'> {
    const access = await this.accessToken();
    const res = await fetch(`${this.apiUrl}/v1/projects/${this.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: payload.title, body: payload.body },
          data: payload.data,
          android: { priority: 'HIGH' },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 && !(await this.isPlatformKeyRefused(res))) return 'AUTH';
    if (res.status === 404 || (await this.isDeadToken(res))) {
      return { ok: false, code: 'UNREGISTERED' };
    }
    this.logger.warn(`FCM refused a message (HTTP ${res.status})`);
    return {
      ok: false,
      code: res.status >= 500 || res.status === 429 ? 'UNAVAILABLE' : 'REJECTED',
    };
  }

  /**
   * FCM's 401 for the phone's own platform: the APNs certificate or web push key is
   * invalid or missing. Our access token is fine, and signing in again changes nothing.
   */
  private async isPlatformKeyRefused(res: Response): Promise<boolean> {
    const body = (await res.json().catch(() => null)) as {
      error?: { details?: { errorCode?: string }[] };
    } | null;
    return (body?.error?.details ?? []).some((d) => d.errorCode === 'THIRD_PARTY_AUTH_ERROR');
  }

  /** FCM's 400 for a token that was never valid (a 404 is one that has gone away). */
  private async isDeadToken(res: Response): Promise<boolean> {
    if (res.status !== 400) return false;
    const body = (await res.json().catch(() => null)) as {
      error?: { details?: { fieldViolations?: { field?: string }[] }[] };
    } | null;
    return (body?.error?.details ?? []).some((d) =>
      (d.fieldViolations ?? []).some((v) => v.field === 'message.token'),
    );
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt > Date.now() + RENEW_EARLY_MS) {
      return this.access.token;
    }
    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: this.assertion(),
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FCM sign-in answered ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('FCM sign-in answered without a token');
    this.access = {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? ASSERTION_TTL_SEC) * 1000,
    };
    return this.access.token;
  }

  /** The service account's signed request for an access token (RS256 JWT). */
  private assertion(): string {
    const now = Math.floor(Date.now() / 1000);
    const head = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: this.clientEmail,
        scope: SCOPE,
        aud: this.tokenUrl,
        iat: now,
        exp: now + ASSERTION_TTL_SEC,
      }),
    );
    const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(this.privateKey);
    return `${head}.${claims}.${base64Url(signature)}`;
  }
}
