import { ExecutionContext } from '@nestjs/common';
import { AuthController } from '@modules/auth/presentation/auth.controller';
import { ActivityController } from '@modules/activity/presentation/activity.controller';
import { RATE_LIMIT_KEY, RATE_LIMITS, rateLimitFor, RouteRateLimit } from './rate-limits';

function context(handler: object, cls: object, req: object): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const metadataOf = (fn: object): RouteRateLimit | undefined =>
  Reflect.getMetadata(RATE_LIMIT_KEY, fn) as RouteRateLimit | undefined;

describe('rate limits for an office behind one address', () => {
  it('sized for 100+ people per address, still per person where a person is known', () => {
    expect(RATE_LIMITS.login.ip).toBeGreaterThanOrEqual(300);
    expect(RATE_LIMITS.refresh.ip).toBeGreaterThanOrEqual(600);
    expect(RATE_LIMITS.socketTicket).toEqual({ user: 30, ip: 600 });
    expect(RATE_LIMITS.activityReport).toEqual({ user: 120, ip: 1200 });
  });

  it('the four routes carry them', () => {
    expect(metadataOf(AuthController.prototype.login)).toBe(RATE_LIMITS.login);
    expect(metadataOf(AuthController.prototype.refresh)).toBe(RATE_LIMITS.refresh);
    expect(metadataOf(AuthController.prototype.socketTicket)).toBe(RATE_LIMITS.socketTicket);
    expect(metadataOf(ActivityController.prototype.reportActivity)).toBe(
      RATE_LIMITS.activityReport,
    );
  });

  it('picks the per-address or per-person limit by who the request counts against', () => {
    const tracker = jest.fn((req: { who?: string }) => req.who ?? 'ip:10.0.0.1');
    const limit = rateLimitFor(tracker, 120);
    const route = AuthController.prototype.socketTicket;
    expect(limit(context(route, AuthController, {}))).toBe(600);
    expect(limit(context(route, AuthController, { who: 'user:u1' }))).toBe(30);
    // A route without its own limits keeps the default, and never runs the tracker.
    tracker.mockClear();
    expect(limit(context(AuthController.prototype.logout, AuthController, {}))).toBe(120);
    expect(tracker).not.toHaveBeenCalled();
  });
});
