import { createHash } from 'crypto';
import { createReadStream, existsSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentBinaryInfo, AgentBinaryStore } from '../domain/agent-binary.store';

/**
 * Serves the agent binary from the local filesystem (developer machines, or a
 * bind-mounted volume). Supports both the single-exe file and the WinUI publish
 * *folder* (shipped as a ZIP) — see {@link AgentBinaryStore}.
 */
@Injectable()
export class LocalAgentBinaryStore implements AgentBinaryStore {
  /** Last hash worked out, keyed by the file it was taken from. */
  private cached?: { key: string; sha256: string };

  constructor(private readonly config: ConfigService) {}

  private path(): string {
    const p = this.config.get<string>('agent.binaryPath') ?? '';
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }

  async info(): Promise<AgentBinaryInfo> {
    const path = this.path();
    if (!existsSync(path)) return { available: false, sizeBytes: 0, isDirectory: false };

    const stat = statSync(path);
    if (stat.isDirectory()) {
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
    return createReadStream(this.path());
  }

  directoryPath(): string | null {
    const path = this.path();
    return existsSync(path) && statSync(path).isDirectory() ? path : null;
  }
}
