import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { CacheService } from './cache.port';

interface Entry {
  value: string;
  expiresAt?: number;
}

/** How often expired entries are swept out. Entries live seconds, so this is the bound on stale ones. */
const SWEEP_EVERY_MS = 30_000;

/**
 * A process-local cache. An expired entry is dropped when it is read and, because
 * most are never read again (a refresh-rotation replay is looked up only inside
 * its 30 second grace), by a periodic sweep: without it every rotation left one
 * entry behind until the process restarted.
 */
@Injectable()
export class MemoryCacheService implements CacheService, OnModuleDestroy {
  private readonly store = new Map<string, Entry>();
  private sweeper: NodeJS.Timeout | null = null;

  async get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value: JSON.stringify(value),
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
    });
    if (ttlSeconds) this.startSweeping();
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async delByPattern(pattern: string): Promise<void> {
    const regex = this.globToRegExp(pattern);
    for (const key of this.store.keys()) {
      if (regex.test(key)) this.store.delete(key);
    }
  }

  onModuleDestroy(): void {
    this.stopSweeping();
  }

  /** Drops every entry whose time is up; stops the timer once nothing is left to expire. */
  private sweep(): void {
    const now = Date.now();
    let expiring = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt === undefined) continue;
      if (entry.expiresAt <= now) this.store.delete(key);
      else expiring += 1;
    }
    if (expiring === 0) this.stopSweeping();
  }

  /** Started by the first entry that can expire. Unref'd: it never keeps the process alive. */
  private startSweeping(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
    this.sweeper.unref();
  }

  private stopSweeping(): void {
    if (!this.sweeper) return;
    clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private isExpired(entry: Entry): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= Date.now();
  }

  private globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${body}$`);
  }
}
