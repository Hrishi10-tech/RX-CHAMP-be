/** Per-user enrollment baked into a download (matches the agent's EmbeddedConfig). */
export interface AgentEnrollConfig {
  ApiBaseUrl: string;
  EnrollmentToken: string;
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
}
