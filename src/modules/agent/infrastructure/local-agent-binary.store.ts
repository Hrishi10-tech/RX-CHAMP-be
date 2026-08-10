import { createReadStream, existsSync, statSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { Readable } from 'stream';
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
  constructor(private readonly config: ConfigService) {}

  private path(): string {
    const p = this.config.get<string>('agent.binaryPath') ?? '';
    return isAbsolute(p) ? p : resolve(process.cwd(), p);
  }

  async info(): Promise<AgentBinaryInfo> {
    const path = this.path();
    if (!existsSync(path)) return { available: false, sizeBytes: 0, isDirectory: false };

    const stat = statSync(path);
    return {
      available: true,
      sizeBytes: stat.isDirectory() ? 0 : stat.size,
      isDirectory: stat.isDirectory(),
    };
  }

  async openStream(): Promise<Readable> {
    return createReadStream(this.path());
  }

  directoryPath(): string | null {
    const path = this.path();
    return existsSync(path) && statSync(path).isDirectory() ? path : null;
  }
}
