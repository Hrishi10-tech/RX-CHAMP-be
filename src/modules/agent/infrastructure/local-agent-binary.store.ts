import { createHash } from 'crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'fs';
import { isAbsolute, relative, resolve, sep } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { AgentBinaryInfo, AgentBinaryStore } from '../domain/agent-binary.store';

const unavailable = (): AgentBinaryInfo => ({ available: false, sizeBytes: 0, isDirectory: false });

/**
 * Serves the agent binary from the local filesystem (developer machines, or a
 * bind-mounted volume). Supports both the single-exe file and the WinUI publish
 * *folder* (shipped as a ZIP) — see {@link AgentBinaryStore}.
 */
export class LocalAgentBinaryStore implements AgentBinaryStore {
  /** Last hash worked out, keyed by the file it was taken from. */
  private cached?: { key: string; sha256: string };

  constructor(private readonly configuredPath: string) {}

  /**
   * Where the build is, or null when no path is configured. An empty path must
   * mean "no local build": resolved, it would be the working directory, and the
   * download route zips whatever directory this store names.
   */
  private path(): string | null {
    const p = (this.configuredPath ?? '').trim();
    if (!p) return null;
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }

  /**
   * True for the process working directory and everything above it (".", "..",
   * "/"). That is the server's own folder (environment file, sources), never an
   * agent publish folder, so it is not served.
   */
  private holdsWorkingDirectory(dir: string): boolean {
    const rel = relative(real(dir), real(process.cwd()));
    const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    return !outside;
  }

  async info(): Promise<AgentBinaryInfo> {
    const path = this.path();
    if (!path || !existsSync(path)) return unavailable();

    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (this.holdsWorkingDirectory(path)) return unavailable();
      return { available: true, sizeBytes: 0, isDirectory: true };
    }
    return {
      available: true,
      sizeBytes: stat.size,
      isDirectory: false,
      // An agent won't install an update it can't verify, so without this a
      // developer could never exercise self-update outside production. Version
      // still comes from config here — only S3 carries one per object.
      sha256: await this.sha256(path, stat.size, stat.mtimeMs),
    };
  }

  /**
   * SHA-256 of the binary, remembered until the file changes. Hashing a hundred
   * megabytes is cheap once and wasteful on every version check, and size plus
   * mtime is enough to notice a rebuild.
   */
  private async sha256(path: string, size: number, mtimeMs: number): Promise<string> {
    const key = `${path}:${size}:${mtimeMs}`;
    if (this.cached?.key === key) return this.cached.sha256;

    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    const sha256 = hash.digest('hex');
    this.cached = { key, sha256 };
    return sha256;
  }

  async openStream(): Promise<Readable> {
    const path = this.path();
    if (!path) throw new Error('No local agent build is configured');
    return createReadStream(path);
  }

  directoryPath(): string | null {
    const path = this.path();
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) return null;
    return this.holdsWorkingDirectory(path) ? null : path;
  }
}

/** The path with symbolic links followed, so a link to the working directory is caught too. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
