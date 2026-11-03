import { WorkdayState } from '@modules/worktime/application/worktime.types';

/**
 * Agent health (3.3): one row per person saying whether their desktop agent is
 * reaching the server, whether their day is running, and whether screenshots are
 * arriving, so "screenshots only work for a few people" can be traced to the
 * person and the cause without the server logs.
 */

export type AgentHealthFlag =
  /** No agent request ever recorded for this person. */
  | 'NEVER_REPORTED'
  /** No live sign-in (refresh token): the agent cannot call until the person signs in again. */
  | 'SIGNED_OUT'
  /** The day is open but the agent has not called for a while. */
  | 'AGENT_OFFLINE'
  /** The agent is calling, it is a working day past the shift start, and the day was never started. */
  | 'DAY_NOT_STARTED'
  /** Automatic screenshots are switched off for this person. */
  | 'SCREENSHOTS_OFF'
  /** The day has been running a while, screenshots are on, and none arrived today. */
  | 'NO_SCREENSHOTS_TODAY'
  /** Screenshots arrived earlier today but stopped while the day is still open. */
  | 'SCREENSHOTS_STALE'
  /** The last upload the server saw from this agent was refused (see lastRefusal). */
  | 'UPLOAD_REFUSED'
  /** An agent older than 3.1 (no Start Day, legacy tracking). */
  | 'OLD_AGENT';

export type AgentLiveStatus = 'ACTIVE' | 'IDLE' | 'OFFLINE' | 'NEVER';

export interface UploadRefusalView {
  at: string;
  status: number;
  code: string;
  reason: string;
  bytes: number | null;
}

export interface AgentHealthRow {
  userId: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  /** 4.0: the person's department (scope is by department; there is no manager line). */
  departmentId: string | null;
  companyId: string | null;
  companyName: string | null;
  agent: {
    /** "3.2.1" from the agent's User-Agent, "legacy" for a 3.0 agent, null when unknown. */
    version: string | null;
    signedIn: boolean;
    /** Any agent request, stored or not (a 3.1 agent before Start Day still calls). */
    lastContactAt: string | null;
    lastSampleAt: string | null;
    lastActiveAt: string | null;
    samplesToday: number;
    status: AgentLiveStatus;
  };
  day: {
    state: WorkdayState;
    startedAt: string | null;
    endedAt: string | null;
    /** A working day by the calendar, with the shift start when there is a shift. */
    workday: boolean;
    shiftStart: string | null;
  };
  screenshots: {
    enabled: boolean;
    lastAt: string | null;
    today: number;
    lastRefusal: UploadRefusalView | null;
  };
  flags: AgentHealthFlag[];
}

export interface AgentHealthSummary {
  people: number;
  tracking: number;
  offline: number;
  notStarted: number;
  ended: number;
  screenshotsOff: number;
  noScreenshots: number;
  refused: number;
}

export interface AgentHealthView {
  date: string;
  /**
   * 4.0: the organisation in view, or null when a Super Admin or the Super Manager
   * sees every organisation at once (rows then carry their companyName).
   */
  organisationId: string | null;
  timezone: string;
  asOf: string;
  summary: AgentHealthSummary;
  rows: AgentHealthRow[];
}
