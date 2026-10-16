import { Injectable } from '@nestjs/common';
import { TooManyAttemptsError } from '@shared/exceptions/app.exception';

interface Entry {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

/**
 * Locks an account's sign-in for a while after repeated wrong passwords, so a
 * known address cannot be guessed at the full request rate. Per account, so it
 * holds however many addresses an attacker spreads the guesses over.
 *
 * In memory: the API runs as one process (ecosystem.config.js). A restart
 * clears the counters, which only ever errs towards letting people in.
 */
@Injectable()
export class LoginAttempts {
  static readonly MAX_FAILURES = 10;
  static readonly WINDOW_MS = 15 * 60_000;
  static readonly LOCK_MS = 15 * 60_000;
  private static readonly MAX_TRACKED = 50_000;

  private readonly entries = new Map<string, Entry>();

  private key(email: string): string {
    return (email ?? '').toLowerCase().trim();
  }

  /** Throws while the account is locked. */
  assertAllowed(email: string, now = Date.now()): void {
    const e = this.entries.get(this.key(email));
    if (!e) return;
    if (e.lockedUntil > now) {
      const minutes = Math.max(1, Math.ceil((e.lockedUntil - now) / 60_000));
      throw new TooManyAttemptsError(
        `Too many wrong passwords. Sign-in is paused for ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      );
    }
  }

  recordFailure(email: string, now = Date.now()): void {
    const k = this.key(email);
    if (!k) return;
    let e = this.entries.get(k);
    if (!e || now - e.firstAt > LoginAttempts.WINDOW_MS) {
      e = { failures: 0, firstAt: now, lockedUntil: 0 };
    }
    e.failures += 1;
    if (e.failures >= LoginAttempts.MAX_FAILURES) {
      e.lockedUntil = now + LoginAttempts.LOCK_MS;
      e.failures = 0;
      e.firstAt = now;
    }
    this.entries.set(k, e);
    if (this.entries.size > LoginAttempts.MAX_TRACKED) this.prune(now);
  }

  recordSuccess(email: string): void {
    this.entries.delete(this.key(email));
  }

  private prune(now: number): void {
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= now && now - e.firstAt > LoginAttempts.WINDOW_MS) this.entries.delete(k);
    }
  }
}
