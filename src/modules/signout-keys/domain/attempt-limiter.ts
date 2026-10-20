/**
 * Failed key attempts per person (docs/4.0/SPEC.md 2.8): after 5 wrong keys in 10
 * minutes, further attempts are refused until the oldest of them is 10 minutes
 * old. In memory: the API runs as one process (ecosystem.config.js), and a restart
 * forgetting a few failures is acceptable.
 */
export class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    readonly maxFailures = 5,
    readonly windowMs = 10 * 60 * 1000,
    private readonly maxPeople = 10_000,
  ) {}

  /** Seconds until another attempt is allowed (0 = allowed now). */
  retryAfterSec(personId: string, now: number): number {
    const recent = this.recent(personId, now);
    if (recent.length < this.maxFailures) return 0;
    const oldest = recent[recent.length - this.maxFailures];
    return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
  }

  recordFailure(personId: string, now: number): void {
    const recent = this.recent(personId, now);
    recent.push(now);
    if (!this.failures.has(personId) && this.failures.size >= this.maxPeople) this.sweep(now);
    this.failures.set(personId, recent);
  }

  reset(personId: string): void {
    this.failures.delete(personId);
  }

  private recent(personId: string, now: number): number[] {
    const list = (this.failures.get(personId) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(personId, list);
    else this.failures.delete(personId);
    return list;
  }

  private sweep(now: number): void {
    for (const id of [...this.failures.keys()]) this.recent(id, now);
    if (this.failures.size >= this.maxPeople) this.failures.clear();
  }
}
