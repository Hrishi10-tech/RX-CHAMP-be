import { AgentContactService, CONTACT_WRITE_INTERVAL_MS } from './agent-contact.service';
import { isAgentRequest } from '../presentation/agent-contact.interceptor';

const flush = () => new Promise((r) => setImmediate(r));

describe('AgentContactService', () => {
  const repo = {
    touch: jest.fn().mockResolvedValue(undefined),
    recordRefusal: jest.fn().mockResolvedValue(undefined),
    forUsers: jest.fn(),
  };
  const t0 = new Date('2026-11-03T06:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);

  beforeEach(() => jest.clearAllMocks());

  it('writes once a minute per person, and at once when the agent changes', async () => {
    const svc = new AgentContactService(repo as never);
    svc.touch('u1', 'RXVisionAgent/3.2.0', t0);
    svc.touch('u1', 'RXVisionAgent/3.2.0', at(10_000));
    svc.touch('u1', 'RXVisionAgent/3.2.0', at(CONTACT_WRITE_INTERVAL_MS - 1));
    expect(repo.touch).toHaveBeenCalledTimes(1);
    svc.touch('u1', 'RXVisionAgent/3.2.0', at(CONTACT_WRITE_INTERVAL_MS));
    expect(repo.touch).toHaveBeenCalledTimes(2);
    svc.touch('u1', 'RXVisionAgent/3.3.0', at(CONTACT_WRITE_INTERVAL_MS + 5));
    expect(repo.touch).toHaveBeenCalledTimes(3);
    svc.touch('u2', null, at(CONTACT_WRITE_INTERVAL_MS + 5));
    expect(repo.touch).toHaveBeenLastCalledWith('u2', null, at(CONTACT_WRITE_INTERVAL_MS + 5));
  });

  it('retries on the next call after a failed write, and never throws', async () => {
    repo.touch.mockRejectedValueOnce(new Error('db away'));
    const svc = new AgentContactService(repo as never);
    svc.touch('u1', null, t0);
    await flush();
    svc.touch('u1', null, at(1000));
    expect(repo.touch).toHaveBeenCalledTimes(2);
  });

  it('records a refusal with the time', () => {
    const svc = new AgentContactService(repo as never);
    svc.refused('u1', { status: 413, code: 'TOO_LARGE', reason: 'big', bytes: 9_000_000 }, t0);
    expect(repo.recordRefusal).toHaveBeenCalledWith('u1', {
      status: 413,
      code: 'TOO_LARGE',
      reason: 'big',
      bytes: 9_000_000,
      at: t0,
    });
  });
});

describe('isAgentRequest', () => {
  it('knows the agent by its User-Agent or by an agent-only route', () => {
    expect(isAgentRequest('GET', '/api/v1/breaks/me/today', 'RXVisionAgent/3.2.0 (Windows)')).toBe(
      true,
    );
    expect(isAgentRequest('POST', '/api/v1/activity/report', undefined)).toBe(true);
    expect(isAgentRequest('POST', '/api/v1/screenshots', 'Mozilla/5.0')).toBe(true);
    expect(isAgentRequest('POST', '/api/v1/presence/heartbeat', undefined)).toBe(true);
    expect(isAgentRequest('POST', '/api/v1/activity/start-day', undefined)).toBe(true);
    expect(isAgentRequest('GET', '/api/v1/screenshots', 'Mozilla/5.0')).toBe(false);
    expect(isAgentRequest('GET', '/api/v1/team/today', 'Mozilla/5.0')).toBe(false);
    expect(isAgentRequest('POST', '/api/v1/screenshots/archive', 'Mozilla/5.0')).toBe(false);
  });
});
