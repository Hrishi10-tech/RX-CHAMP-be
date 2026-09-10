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
  /**
   * Version of the binary actually in the store, stamped on it at upload time.
   *
   * The point of reading it from the store rather than an env var is that
   * releasing an agent must not need the backend redeployed: publishing a build
   * is the whole release, and every agent in the field learns about it from the
   * object itself. Undefined where the store can't say (a local dev build), and
   * the configured version is used instead.
   */
  version?: string;
  /** SHA-256 of those bytes, so an agent can refuse a download that arrived wrong. */
  sha256?: string;
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
