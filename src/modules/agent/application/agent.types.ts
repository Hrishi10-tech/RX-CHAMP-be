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
}
