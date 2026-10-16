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
