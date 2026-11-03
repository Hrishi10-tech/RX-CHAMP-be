export const AGENT_HEALTH_READER = Symbol('AGENT_HEALTH_READER');

/** A person listed on the health page (4.0: organisation and department, no manager line). */
export interface AgentHealthPerson {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  department: string | null;
  departmentId: string | null;
  companyId: string | null;
  companyName: string | null;
}

export interface SampleStats {
  lastAt: Date | null;
  lastActiveAt: Date | null;
  /** Samples stored on `date` (the server's local day, as activity files them). */
  today: number;
  lastIdle: boolean;
}

export interface ScreenshotStats {
  lastAt: Date | null;
  /** Screenshots taken since the start of the local day. */
  today: number;
}

export interface SignInStats {
  /** A refresh token the agent or portal could still use. */
  signedIn: boolean;
  /** The newest agent User-Agent among this person's sign-ins, or null. */
  agentUserAgent: string | null;
}

/** Bulk reads for the health view: one query per table for the whole page. */
export interface AgentHealthReader {
  /**
   * The people matching a users `where` built by agentHealthPeopleWhere (4.0
   * tenancy rules), by name.
   */
  people(where: Record<string, unknown>): Promise<AgentHealthPerson[]>;
  sampleStats(userIds: string[], date: string): Promise<Map<string, SampleStats>>;
  screenshotStats(userIds: string[], dayStart: Date): Promise<Map<string, ScreenshotStats>>;
  signIns(userIds: string[], now: Date): Promise<Map<string, SignInStats>>;
  screenshotsEnabled(userIds: string[]): Promise<Map<string, boolean>>;
}
