import { isOfflineAgent, isReplayRoute, REPLAY_ROUTES, replayKinds } from './replay-routes';

describe('replay routes (docs/4.0/SPEC.md 6)', () => {
  it('are the actions the 4.0 agent journals, whatever the parameter is called', () => {
    expect(isReplayRoute('POST', '/api/v1/activity/start-day')).toBe(true);
    expect(isReplayRoute('post', '/api/v1/breaks/:id/pause')).toBe(true);
    expect(isReplayRoute('POST', '/api/v1/breaks/:breakId/resume')).toBe(true);
    expect(isReplayRoute('POST', '/api/v1/meetings/:meetingId/end/')).toBe(true);
    expect(isReplayRoute('POST', '/api/v1/away')).toBe(true);
    expect(isReplayRoute('POST', '/activity/end-day')).toBe(true);
    expect(isReplayRoute('POST', '/api/v2/presence/end')).toBe(true);
  });

  it('nothing else: approvals, reports, people, settings, GETs, other methods', () => {
    for (const [method, path] of [
      ['POST', '/api/v1/approvals/:type/:id/approve'],
      ['POST', '/api/v1/breaks/approvals/:id/approve'],
      ['POST', '/api/v1/approvals/bulk-approve'],
      ['POST', '/api/v1/activity/report'],
      ['POST', '/api/v1/presence/heartbeat'],
      ['PATCH', '/api/v1/settings'],
      ['PUT', '/api/v1/calendar/week-pattern'],
      ['POST', '/api/v1/users'],
      ['GET', '/api/v1/activity/start-day'],
      ['DELETE', '/api/v1/breaks/end'],
      ['POST', '/api/v1/breaks/end/extra'],
    ]) {
      expect(isReplayRoute(method, path)).toBe(false);
    }
  });

  it('their stored kinds carry the API prefix of the request', () => {
    const kinds = replayKinds('/api/v1/breaks/end');
    expect(kinds).toHaveLength(REPLAY_ROUTES.length);
    expect(kinds).toContain('POST /api/v1/activity/start-day');
    expect(kinds).toContain('POST /api/v1/breaks/:id/pause');
    expect(replayKinds('/breaks/end')).toContain('POST /away');
  });

  it('only a 4.0 or later agent replays offline', () => {
    expect(isOfflineAgent('RXVisionAgent/4.0.0 (Windows)')).toBe(true);
    expect(isOfflineAgent('RXVisionAgent/4.12.3 (macOS)')).toBe(true);
    expect(isOfflineAgent('RXVisionAgent/5.0.0 (Windows)')).toBe(true);
    expect(isOfflineAgent('RXVisionAgent/3.1.0 (Windows)')).toBe(false);
    expect(isOfflineAgent('Mozilla/5.0 RXVisionAgent/4.0.0')).toBe(false);
    expect(isOfflineAgent('curl/8.5.0')).toBe(false);
    expect(isOfflineAgent(undefined)).toBe(false);
  });
});
