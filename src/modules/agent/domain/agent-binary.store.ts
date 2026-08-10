import { Readable } from 'stream';

export const AGENT_BINARY_STORE = Symbol('AGENT_BINARY_STORE');

/** What's known about the agent binary without fetching its bytes. */
export interface AgentBinaryInfo {
  /** True when a binary is actually there to download. */
  available: boolean;
  /** Size of the single-file binary in bytes (0 when unavailable or a directory). */
  sizeBytes: number;
  /**
   * True only for a local WinUI publish *folder*, which is shipped as a ZIP. An
   * S3-backed binary is always a single object, so this is always false there.
   */
  isDirectory: boolean;
}

/**
 * Where the downloadable Windows agent lives. On a developer box it's a path on
 * disk; in a container (where the installer folder was never copied into the
 * image) it's an object in S3. The controller talks to this port so it doesn't
 * care which.
 */
export interface AgentBinaryStore {
  /** Availability + size, cheaply (a stat / HEAD — never the whole file). */
  info(): Promise<AgentBinaryInfo>;

  /** Byte stream of a single-file binary. Only valid when `isDirectory` is false. */
  openStream(): Promise<Readable>;

  /** Local directory to ZIP up, or null when the source isn't a directory. */
  directoryPath(): string | null;
}
