export const AGENT_CONTACT_REPOSITORY = Symbol('AGENT_CONTACT_REPOSITORY');

/** Why the server refused a screenshot upload, as the health view shows it. */
export interface UploadRefusal {
  at: Date;
  /** HTTP status the agent got (400, 403, 409, 413). */
  status: number;
  /** Short machine code: NOT_AN_IMAGE, TOO_LARGE, AUTO_OFF, DAY_ENDED, EMPTY, NO_FILE. */
  code: string;
  reason: string;
  bytes: number | null;
}

export interface AgentContactRecord {
  userId: string;
  lastContactAt: Date;
  userAgent: string | null;
  lastRefusal: UploadRefusal | null;
}

/**
 * Per-person agent diagnostics (3.3). `touch` is called on every agent request
 * (throttled by the service), `recordRefusal` whenever an upload is turned away,
 * so "the agent is alive but nothing arrives" is visible without server logs.
 */
export interface AgentContactRepository {
  touch(userId: string, userAgent: string | null, at: Date): Promise<void>;
  recordRefusal(userId: string, refusal: UploadRefusal): Promise<void>;
  forUsers(userIds: string[]): Promise<Map<string, AgentContactRecord>>;
}
