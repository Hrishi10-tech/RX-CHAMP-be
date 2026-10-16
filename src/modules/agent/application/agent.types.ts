/** Per-user enrollment baked into a download (matches the agent's EmbeddedConfig). */
export interface AgentEnrollConfig {
  ApiBaseUrl: string;
  EnrollmentToken: string;
}

/**
 * A setup code: the same enrollment as a Windows download, as text the person
 * pastes into the agent's sign-in screen. Used for the Mac agent, whose signed
 * app cannot carry a per-user payload.
 */
export interface AgentSetupCode {
  /** "RXV1." + base64url(JSON {ApiBaseUrl, EnrollmentToken}). */
  code: string;
  apiBaseUrl: string;
  userId: string;
}

export interface AgentVersionInfo {
  version: string;
  fileName: string;
  available: boolean;
  sizeBytes: number;
  /**
   * SHA-256 of the download, or '' when the store can't say. An agent updating
   * itself checks it before running what it fetched; empty means "unverifiable",
   * and the agent declines rather than trusting it.
   */
  sha256: string;
  /** Which build this describes: windows (installer .exe), mac (Apple Silicon .app zip) or mac-x64 (Intel). */
  platform: 'windows' | 'mac' | 'mac-x64';
}
