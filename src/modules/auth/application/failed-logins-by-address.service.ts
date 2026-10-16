import { Injectable } from '@nestjs/common';

/**
 * Wrong passwords per client address. The per-address request limit lets 300
 * sign-ins a minute through, so a whole office behind one NAT address can sign in
 * at 09:30; spraying one guess per account would never trip the per-account
 * lockout at that rate. So an address may fail at most MAX_FAILURES times in
 * WINDOW_MS; over that, sign-in from it is refused (429 TOO_MANY_ATTEMPTS) except
 * for accounts that already signed in from it (LoginUserUseCase), so the office
 * keeps working while the guessing stops.
 *
 * In memory, like LoginAttempts: the API runs as one process, and a restart only
 * ever errs towards letting people in.
 *
 * LOGIN_FAILED_PER_IP_MAX (default 30, 5 to 10000) and LOGIN_FAILED_PER_IP_WINDOW_MIN
 * (default 10, 1 to 1440) tune it, e.g. for a large office on its first morning.
 */
@Injectable()
export class FailedLoginsByAddress {
  static readonly MAX_FAILURES = 30;
  static readonly WINDOW_MS = 10 * 60_000;
  private static readonly MAX_TRACKED = 50_000;

  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor() {
    const limits = failedLoginLimits(process.env);
    this.maxFailures = limits.maxFailures;
    this.windowMs = limits.windowMs;
  }

  /** The most recent failures per address (at most MAX_FAILURES), oldest first. */
  private readonly failures = new Map<string, number[]>();

  /** Whole minutes until the address is under the limit again; 0 when it is now. */
  blockedForMin(ip: string | null, now = Date.now()): number {
    if (!ip) return 0;
    const list = this.failures.get(ip);
    if (!list || list.length < this.maxFailures) return 0;
    const clearsAt = list[0] + this.windowMs;
    return clearsAt > now ? Math.max(1, Math.ceil((clearsAt - now) / 60_000)) : 0;
  }

  recordFailure(ip: string | null, now = Date.now()): void {
    if (!ip) return;
    const list = (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    while (list.length > this.maxFailures) list.shift();
    this.failures.set(ip, list);
    if (this.failures.size > FailedLoginsByAddress.MAX_TRACKED) this.prune(now);
  }

  private prune(now: number): void {
    for (const [ip, list] of this.failures) {
      if (!list.length || now - list[list.length - 1] >= this.windowMs) {
        this.failures.delete(ip);
      }
    }
  }
}

/** The failed-login limit per address, from the environment with safe bounds. */
export function failedLoginLimits(env: NodeJS.ProcessEnv): {
  maxFailures: number;
  windowMs: number;
} {
  const int = (raw: string | undefined, min: number, max: number, fallback: number): number => {
    const n = Number.parseInt((raw ?? '').trim(), 10);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  };
  return {
    maxFailures: int(env.LOGIN_FAILED_PER_IP_MAX, 5, 10_000, FailedLoginsByAddress.MAX_FAILURES),
    windowMs:
      int(env.LOGIN_FAILED_PER_IP_WINDOW_MIN, 1, 1_440, FailedLoginsByAddress.WINDOW_MS / 60_000) *
      60_000,
  };
}
