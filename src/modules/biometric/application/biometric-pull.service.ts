import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError } from '@shared/exceptions/app.exception';
import { appTimezone, zonedParts } from '@shared/utils/timezone';
import { PullConfig, TimeFormat } from '../domain/biometric-settings';
import { BIOMETRIC_REPOSITORY, BiometricRepository } from '../domain/biometric.repository';
import { PunchInput } from '../domain/punch';
import { BiometricIngestService, IngestResult } from './biometric-ingest.service';
import { BiometricSettingsService, PullState } from './biometric-settings.service';

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PAGES = 50;
/** The first read goes back this far. */
const FIRST_WINDOW_MS = 24 * 3_600_000;
const TOKEN_TTL_MS = 30 * 60_000;

/** A value at a dot path ("data.items", "employee.code"); the whole object for "". */
export function atPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** An instant for a query string, as the remote system expects it. */
export function queryTime(at: Date, format: TimeFormat, tz: string): string {
  switch (format) {
    case 'EPOCH_S':
      return String(Math.floor(at.getTime() / 1000));
    case 'EPOCH_MS':
      return String(at.getTime());
    case 'LOCAL': {
      const p = zonedParts(at, tz);
      return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
    }
    default:
      return at.toISOString();
  }
}

/** A row's time as the punch parser reads it, given how the remote system writes it. */
function rowTime(raw: unknown, format: TimeFormat): unknown {
  if (format === 'EPOCH_S' && raw !== null && raw !== undefined) return Number(raw);
  if (format === 'EPOCH_MS' && raw !== null && raw !== undefined) return Number(raw);
  return raw;
}

/**
 * Link-local addresses (the cloud metadata service) are never read; loopback only
 * outside production. LAN addresses are allowed: biometric servers often sit on one.
 */
export async function assertSafeUrl(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConflictError('The pull URL is not a valid URL.', 'PULL_URL_INVALID');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ConflictError('The pull URL must be http or https.', 'PULL_URL_INVALID');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  const production = process.env.NODE_ENV === 'production';
  for (const a of addresses) {
    const v = a.toLowerCase();
    const linkLocal = v.startsWith('169.254.') || v.startsWith('fe80:') || v === 'fd00:ec2::254';
    const loopback = v.startsWith('127.') || v === '::1' || v === '0.0.0.0';
    if (linkLocal || (production && loopback)) {
      throw new ConflictError(
        'The pull URL points at an address the server never reads (link-local or loopback).',
        'PULL_URL_BLOCKED',
      );
    }
  }
}

async function readJson(res: Response): Promise<unknown> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) throw new Error(`answer is larger than ${MAX_BODY_BYTES} bytes`);
  const text = await res.text();
  if (text.length > MAX_BODY_BYTES)
    throw new Error(`answer is larger than ${MAX_BODY_BYTES} bytes`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`answer is not JSON (it starts "${text.slice(0, 60).replace(/\s+/g, ' ')}")`);
  }
}

export interface PullRunResult {
  ok: boolean;
  read: number;
  pages: number;
  from: string;
  to: string;
  /** Test: the first rows as understood, nothing saved. */
  sample?: {
    code: unknown;
    time: unknown;
    direction: unknown;
    deviceId: unknown;
    externalId: unknown;
  }[];
  stored?: IngestResult;
  error?: string;
}

/**
 * The pull adapter (3.5): reads punches from the biometric system's API on a
 * timer, re-reading the last minutes each time (devices sync late), and stores them
 * like pushed ones. Generic: the URL, the sign-in, where the list and each field
 * are, how directions and times are written. A BioTime preset fills the mapping.
 * 4.0: each organisation has its own pull (settings, secret, state, sign-in token),
 * and what it reads is that organisation's punches.
 */
@Injectable()
export class BiometricPullService {
  private readonly logger = new Logger(BiometricPullService.name);
  /** Organisations with a pull running now. */
  private readonly running = new Set<string>();
  private readonly tokens = new Map<string, { value: string; at: number }>();

  constructor(
    private readonly settings: BiometricSettingsService,
    private readonly ingest: BiometricIngestService,
    @Inject(BIOMETRIC_REPOSITORY) private readonly repo: BiometricRepository,
  ) {}

  /** The job: each organisation's pull runs when switched on and due. */
  async tick(now: Date): Promise<void> {
    for (const companyId of await this.repo.companyIds()) {
      try {
        const s = await this.settings.get(companyId);
        if (!s.pull.enabled || !s.pull.url || this.running.has(companyId)) continue;
        const state = await this.settings.pullState(companyId);
        const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
        if (now.getTime() - last < s.pull.everyMin * 60_000 - 5_000) continue;
        await this.run(companyId, now, false);
      } catch (err) {
        this.logger.warn(`biometric pull of ${companyId}: ${(err as Error).message}`);
      }
    }
  }

  /** Reads the window once; `dryRun` saves nothing and returns what it understood. */
  async run(companyId: string, now: Date, dryRun: boolean): Promise<PullRunResult> {
    if (this.running.has(companyId)) {
      throw new ConflictError('A pull is already running.', 'PULL_RUNNING');
    }
    this.running.add(companyId);
    const s = await this.settings.get(companyId);
    const state = await this.settings.pullState(companyId);
    const cfg = s.pull;
    const from = state.cursor
      ? new Date(Date.parse(state.cursor) - cfg.overlapMin * 60_000)
      : new Date(now.getTime() - FIRST_WINDOW_MS);
    const window = { from: from.toISOString(), to: now.toISOString() };
    try {
      if (!cfg.url) throw new Error('no URL is set');
      await assertSafeUrl(cfg.url);
      const rows = await this.fetchAll(companyId, cfg, from, now);
      const inputs: PunchInput[] = rows.list.map((r) => ({
        code: atPath(r, cfg.fields.code),
        time: rowTime(atPath(r, cfg.fields.time), cfg.timeFormat),
        direction: cfg.fields.direction ? atPath(r, cfg.fields.direction) : undefined,
        deviceId: cfg.fields.deviceId ? atPath(r, cfg.fields.deviceId) : undefined,
        externalId: cfg.fields.externalId ? atPath(r, cfg.fields.externalId) : undefined,
      }));
      if (dryRun) {
        return {
          ok: true,
          read: inputs.length,
          pages: rows.pages,
          ...window,
          sample: inputs.slice(0, 5).map((i) => ({
            code: i.code,
            time: i.time,
            direction: i.direction,
            deviceId: i.deviceId,
            externalId: i.externalId,
          })),
        };
      }
      const total: IngestResult = {
        received: 0,
        stored: 0,
        duplicates: 0,
        unmatched: 0,
        lockedOut: 0,
        daysUpdated: 0,
        ignored: [],
      };
      for (let i = 0; i < inputs.length; i += 500) {
        const r = await this.ingest.ingest(companyId, inputs.slice(i, i + 500), 'PULL', { now });
        total.received += r.received;
        total.stored += r.stored;
        total.duplicates += r.duplicates;
        total.unmatched += r.unmatched;
        total.lockedOut += r.lockedOut;
        total.daysUpdated += r.daysUpdated;
        total.ignored.push(
          ...r.ignored.slice(0, 20).map((x) => ({ index: x.index + i, reason: x.reason })),
        );
      }
      await this.save(companyId, state, now, {
        ok: true,
        count: total.stored,
        cursor: now.toISOString(),
      });
      return { ok: true, read: inputs.length, pages: rows.pages, ...window, stored: total };
    } catch (err) {
      const message = err instanceof ConflictError ? err.message : (err as Error).message;
      if (!dryRun) await this.save(companyId, state, now, { ok: false, error: message });
      this.logger.warn(`biometric pull of ${companyId} failed: ${message}`);
      return { ok: false, read: 0, pages: 0, ...window, error: message };
    } finally {
      this.running.delete(companyId);
    }
  }

  private async save(
    companyId: string,
    state: PullState,
    now: Date,
    r: { ok: boolean; count?: number; cursor?: string; error?: string },
  ): Promise<void> {
    await this.settings
      .savePullState(companyId, {
        lastRunAt: now.toISOString(),
        lastOkAt: r.ok ? now.toISOString() : state.lastOkAt,
        lastError: r.ok ? null : (r.error ?? 'failed'),
        lastCount: r.ok ? (r.count ?? 0) : state.lastCount,
        cursor: r.cursor ?? state.cursor,
      })
      .catch(() => undefined);
  }

  private async headers(
    companyId: string,
    cfg: PullConfig,
    fresh = false,
  ): Promise<Record<string, string>> {
    const { secret, password } = await this.settings.secrets(companyId);
    const h: Record<string, string> = { Accept: 'application/json' };
    switch (cfg.authType) {
      case 'BEARER':
        if (secret) h.Authorization = `Bearer ${secret}`;
        break;
      case 'TOKEN':
        if (secret) h.Authorization = `Token ${secret}`;
        break;
      case 'JWT':
        if (secret) h.Authorization = `JWT ${secret}`;
        break;
      case 'HEADER':
        if (secret) h[cfg.authHeader || 'X-API-Key'] = secret;
        break;
      case 'BASIC':
        h.Authorization = `Basic ${Buffer.from(`${cfg.username}:${password ?? secret ?? ''}`).toString('base64')}`;
        break;
      case 'LOGIN': {
        const token = await this.login(companyId, cfg, password ?? secret ?? '', fresh);
        h.Authorization = `${cfg.tokenScheme || 'Token'} ${token}`;
        break;
      }
    }
    return h;
  }

  private async login(
    companyId: string,
    cfg: PullConfig,
    password: string,
    fresh: boolean,
  ): Promise<string> {
    const cached = this.tokens.get(companyId);
    if (!fresh && cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.value;
    await assertSafeUrl(cfg.loginUrl);
    const res = await fetch(cfg.loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: cfg.username, password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`sign-in answered ${res.status}`);
    const token = atPath(await readJson(res), cfg.tokenPath || 'token');
    if (typeof token !== 'string' || !token)
      throw new Error(`no token at "${cfg.tokenPath}" in the sign-in answer`);
    this.tokens.set(companyId, { value: token, at: Date.now() });
    return token;
  }

  private async fetchAll(
    companyId: string,
    cfg: PullConfig,
    from: Date,
    to: Date,
  ): Promise<{ list: unknown[]; pages: number }> {
    const tz = appTimezone();
    const first = new URL(cfg.url);
    if (cfg.sinceParam)
      first.searchParams.set(cfg.sinceParam, queryTime(from, cfg.queryTimeFormat, tz));
    if (cfg.untilParam)
      first.searchParams.set(cfg.untilParam, queryTime(to, cfg.queryTimeFormat, tz));
    const list: unknown[] = [];
    let next: string | null = first.toString();
    let pages = 0;
    let retried = false;
    while (next && pages < MAX_PAGES) {
      await assertSafeUrl(next);
      const res = await fetch(next, {
        headers: await this.headers(companyId, cfg, retried),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
      if (res.status === 401 && cfg.authType === 'LOGIN' && !retried) {
        retried = true;
        continue;
      }
      if (!res.ok)
        throw new Error(`the biometric system answered ${res.status} ${res.statusText}`.trim());
      const body = await readJson(res);
      const page = atPath(body, cfg.listPath);
      if (!Array.isArray(page)) {
        throw new Error(
          cfg.listPath ? `no list at "${cfg.listPath}" in the answer` : 'the answer is not a list',
        );
      }
      list.push(...page);
      pages += 1;
      const n = cfg.nextPath ? atPath(body, cfg.nextPath) : null;
      next = typeof n === 'string' && n ? new URL(n, next).toString() : null;
    }
    return { list, pages };
  }
}
