/**
 * Which client is calling, judged from the User-Agent (SPEC 1.1, 3.1).
 *
 * A 3.1+ agent sends `RXVisionAgent/<major>.<minor>... (<platform>)` with a
 * version of 3.1 or later. Everything else is legacy: no User-Agent, the portal,
 * the 3.0 agent and the 2.x WinUI agent. Gates and DAY_NOT_STARTED apply to 3.1+
 * agents only; legacy callers keep the 3.0 behaviour (an implicit work session).
 */
export type AgentGeneration = 'AGENT_31' | 'LEGACY';

const AGENT_UA = /^RXVisionAgent\/(\d+)\.(\d+)/;

export function agentGeneration(userAgent: string | null | undefined): AgentGeneration {
  const m = AGENT_UA.exec(userAgent ?? '');
  if (!m) return 'LEGACY';
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 3 || (major === 3 && minor >= 1) ? 'AGENT_31' : 'LEGACY';
}

export function isAgent31(userAgent: string | null | undefined): boolean {
  return agentGeneration(userAgent) === 'AGENT_31';
}

/** 4.0+ agents (`RXVisionAgent/4.`): MoM sender required, no overrun asks, offline replay. */
export function isAgent40(userAgent: string | null | undefined): boolean {
  const m = AGENT_UA.exec(userAgent ?? '');
  return !!m && Number(m[1]) >= 4;
}

/** The agent's version from its User-Agent, or null for anything that is not the agent. */
export function agentVersionOf(
  userAgent: string | null | undefined,
): { major: number; minor: number } | null {
  const m = AGENT_UA.exec(userAgent ?? '');
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * What the calling agent can do (3.2). A new server rule that needs the agent to ask
 * the person something applies only to agents that can ask it; older agents carry on
 * as before and the person is told instead.
 */
export interface AgentCaps {
  /** Asks why the day starts late, and sends it with Start Day (`lateReason`). */
  lateStartReason: boolean;
}

export const NO_AGENT_CAPS: AgentCaps = { lateStartReason: false };

export function agentCaps(userAgent: string | null | undefined): AgentCaps {
  const v = agentVersionOf(userAgent);
  // 3.2 to 3.x agents ask; the 4.0.x agents grew from 3.1 and do not, 4.1 and later do.
  const asks =
    !!v && ((v.major === 3 && v.minor >= 2) || (v.major === 4 && v.minor >= 1) || v.major > 4);
  return { lateStartReason: asks };
}
