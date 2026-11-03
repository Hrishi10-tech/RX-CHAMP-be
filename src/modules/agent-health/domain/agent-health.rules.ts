import { LIVE_GRACE_SEC } from '@modules/activity/application/activity.constants';
import { WorkdayState } from '@modules/worktime/application/worktime.types';
import { AgentHealthFlag, AgentLiveStatus } from '../application/agent-health.types';

/** The agent has not called for this long while the day is open: offline. */
export const OFFLINE_AFTER_SEC = 5 * 60;
/** The agent called within this long: it is running (whatever it stores). */
export const ALIVE_WITHIN_SEC = 15 * 60;
/** A working day whose shift started this long ago with no Start Day is flagged. */
export const NOT_STARTED_AFTER_SEC = 30 * 60;
/** A day open this long with no screenshot at all is flagged. */
export const NO_SHOTS_AFTER_SEC = 30 * 60;
/** Screenshots stopped this long ago while the day runs and the agent is alive: stale. */
export const SHOTS_STALE_AFTER_SEC = 45 * 60;

export interface HealthFacts {
  now: Date;
  /** Any agent request (stored or not) and the newest stored sample. */
  lastContactAt: Date | null;
  lastSampleAt: Date | null;
  lastSampleIdle: boolean;
  signedIn: boolean;
  /** "3.2.1", "legacy" (an agent that sends no RXVisionAgent User-Agent) or null (never seen). */
  agentVersion: string | null;
  dayState: WorkdayState;
  dayStartedAt: Date | null;
  workday: boolean;
  shiftStart: Date | null;
  screenshotsEnabled: boolean;
  lastShotAt: Date | null;
  shotsToday: number;
  lastRefusalAt: Date | null;
  /** Start of the local day, so a refusal from yesterday does not flag today. */
  dayStart: Date;
}

const ageSec = (at: Date | null, now: Date): number =>
  at ? Math.max(0, (now.getTime() - at.getTime()) / 1000) : Number.POSITIVE_INFINITY;

const latest = (a: Date | null, b: Date | null): Date | null => (!a ? b : !b ? a : a > b ? a : b);

/** The agent's version from its User-Agent: "3.2.1"; null when it is not the agent. */
export function agentVersionLabel(userAgent: string | null | undefined): string | null {
  const m = /^RXVisionAgent\/(\d+(?:\.\d+){0,2})/.exec(userAgent ?? '');
  return m ? m[1] : null;
}

export function liveStatus(
  f: Pick<HealthFacts, 'now' | 'lastContactAt' | 'lastSampleAt' | 'lastSampleIdle'>,
): AgentLiveStatus {
  const seen = latest(f.lastContactAt, f.lastSampleAt);
  if (!seen) return 'NEVER';
  if (ageSec(seen, f.now) > LIVE_GRACE_SEC) return 'OFFLINE';
  return f.lastSampleIdle ? 'IDLE' : 'ACTIVE';
}

/** What is wrong, if anything, in the order the portal lists them. */
export function healthFlags(f: HealthFacts): AgentHealthFlag[] {
  const flags: AgentHealthFlag[] = [];
  const seen = latest(f.lastContactAt, f.lastSampleAt);
  const alive = ageSec(seen, f.now) <= ALIVE_WITHIN_SEC;

  if (!seen) flags.push('NEVER_REPORTED');
  if (!f.signedIn) flags.push('SIGNED_OUT');
  if (f.dayState === 'OPEN' && ageSec(seen, f.now) > OFFLINE_AFTER_SEC) flags.push('AGENT_OFFLINE');
  if (
    f.dayState === 'NOT_STARTED' &&
    f.workday &&
    f.shiftStart &&
    ageSec(f.shiftStart, f.now) > NOT_STARTED_AFTER_SEC &&
    alive
  ) {
    flags.push('DAY_NOT_STARTED');
  }
  if (!f.screenshotsEnabled) {
    flags.push('SCREENSHOTS_OFF');
  } else if (f.dayState !== 'NOT_STARTED' && f.dayStartedAt) {
    const running = f.dayState === 'OPEN';
    const longEnough = ageSec(f.dayStartedAt, f.now) > NO_SHOTS_AFTER_SEC;
    if (f.shotsToday === 0 && longEnough && (alive || !running)) flags.push('NO_SCREENSHOTS_TODAY');
    else if (
      running &&
      f.shotsToday > 0 &&
      alive &&
      ageSec(f.lastShotAt, f.now) > SHOTS_STALE_AFTER_SEC
    ) {
      flags.push('SCREENSHOTS_STALE');
    }
  }
  if (
    f.lastRefusalAt &&
    f.lastRefusalAt >= f.dayStart &&
    (!f.lastShotAt || f.lastRefusalAt > f.lastShotAt)
  ) {
    flags.push('UPLOAD_REFUSED');
  }
  if (f.agentVersion === 'legacy' && seen) flags.push('OLD_AGENT');
  return flags;
}
