/**
 * The agent actions whose time the server takes from X-Event-At (docs/4.0/SPEC.md 6):
 * exactly what the 4.0 desktop agent journals while offline and replays later
 * (agent/src/RXVision.Agent.Core/Offline/EventRequests.cs). Every other route runs
 * at the server's time even when the headers are sent (an approval can never be
 * back-dated), while X-Client-Event-Id still makes it idempotent.
 */
export const REPLAY_ROUTES: readonly string[] = Object.freeze([
  'POST /activity/start-day',
  'POST /activity/end-day',
  'POST /breaks/start',
  'POST /breaks/end',
  'POST /breaks/quick/start',
  'POST /breaks/:id/pause',
  'POST /breaks/:id/resume',
  'POST /breaks/skip',
  'POST /breaks/:id/comment',
  'POST /meetings/start',
  'POST /meetings/past',
  'POST /meetings/:id/end',
  'POST /away',
  'POST /away/unexplained',
  'POST /presence/start',
  'POST /presence/end',
]);

const AGENT_UA = /^RXVisionAgent\/(\d+)\./;

/**
 * A 4.0 or later desktop agent (`RXVisionAgent/4.`), the only client that journals
 * actions offline (same reading as isAgent40 in worktime/domain/agent-generation).
 */
export function isOfflineAgent(userAgent: string | null | undefined): boolean {
  const m = AGENT_UA.exec(userAgent ?? '');
  return !!m && Number(m[1]) >= 4;
}

const PREFIX = /^\/api\/v\d+(?=\/)/;
const ALLOWED = new Set(REPLAY_ROUTES);

/** "/api/v1/breaks/:breakId/pause" -> { prefix: "/api/v1", path: "/breaks/:id/pause" }. */
function split(routePath: string): { prefix: string; path: string } {
  const prefix = PREFIX.exec(routePath)?.[0] ?? '';
  const path = (routePath.slice(prefix.length) || '/')
    .replace(/\/:[^/]+/g, '/:id')
    .replace(/\/+$/, '');
  return { prefix, path: path || '/' };
}

/** Whether `METHOD /api/v1/route/:param` is an agent action replayed at its event time. */
export function isReplayRoute(method: string, routePath: string): boolean {
  return ALLOWED.has(`${method.toUpperCase()} ${split(routePath).path}`);
}

/**
 * The stored `agent_events.kind` of every replayed action, under the same API
 * prefix as `routePath` (the order check compares only with those).
 */
export function replayKinds(routePath: string): string[] {
  const { prefix } = split(routePath);
  return REPLAY_ROUTES.map((r) => {
    const [method, path] = r.split(' ');
    return `${method} ${prefix}${path}`;
  });
}
