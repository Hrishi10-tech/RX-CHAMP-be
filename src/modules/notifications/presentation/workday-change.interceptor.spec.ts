import { workdayChangeOf } from './workday-change.interceptor';

describe('workdayChangeOf (3.4)', () => {
  it('names the agent requests that change the working day', () => {
    expect(workdayChangeOf('POST', '/api/v1/activity/start-day')).toBe('DAY');
    expect(workdayChangeOf('POST', '/api/v1/activity/end-day')).toBe('DAY');
    expect(workdayChangeOf('POST', '/api/v1/breaks/start')).toBe('BREAK');
    expect(workdayChangeOf('POST', '/api/v1/breaks/end')).toBe('BREAK');
    expect(workdayChangeOf('POST', '/api/v1/breaks/skip')).toBe('BREAK');
    expect(workdayChangeOf('POST', '/api/v1/presence/start')).toBe('PRESENCE');
    expect(workdayChangeOf('POST', '/api/v1/presence/end')).toBe('PRESENCE');
    expect(workdayChangeOf('POST', '/api/v1/meetings/start')).toBe('MEETING');
    expect(workdayChangeOf('POST', '/api/v1/meetings/0b1c/end')).toBe('MEETING');
    expect(workdayChangeOf('POST', '/api/v1/meetings/status/start')).toBe('MEETING');
    expect(workdayChangeOf('POST', '/api/v1/meetings/status/end')).toBe('MEETING');
    expect(workdayChangeOf('POST', '/api/v1/meetings/status/confirm')).toBe('MEETING');
  });

  it('ignores reads, heartbeats, samples and everything else', () => {
    expect(workdayChangeOf('GET', '/api/v1/activity/start-day')).toBeNull();
    expect(workdayChangeOf('POST', '/api/v1/presence/heartbeat')).toBeNull();
    expect(workdayChangeOf('POST', '/api/v1/activity/report')).toBeNull();
    expect(workdayChangeOf('POST', '/api/v1/breaks/approvals/1/approve')).toBeNull();
    expect(workdayChangeOf('POST', '/api/v1/leave/requests')).toBeNull();
  });
});
