import { ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const RATE_LIMIT_KEY = 'rxv:rate-limit';

/** Requests per minute on one route: per signed-in person, and per client address. */
export interface RouteRateLimit {
  user: number;
  ip: number;
}

/**
 * Per-minute limits on the routes a whole office hits at once. A request counts
 * against the signed-in person when it carries a valid access token, else against
 * the client address (throttle-tracker.ts), and an office of 100+ people behind
 * one NAT address shares the address buckets: at 09:30 everyone signs in (agent
 * and portal), every access token expires on the same schedule, and an API restart
 * or a deploy reconnects every agent within a minute. The address limits are sized
 * for that; password guessing is stopped per account by LoginAttempts (10 wrong
 * passwords in 15 minutes pause that account's sign-in for 15 minutes).
 */
export const RATE_LIMITS = {
  /** POST /auth/login. */
  login: { user: 300, ip: 300 },
  /** POST /auth/refresh (carries the refresh cookie, so nearly always counted per address). */
  refresh: { user: 600, ip: 600 },
  /** GET /auth/socket-ticket (every socket reconnect asks for one). */
  socketTicket: { user: 30, ip: 600 },
  /** POST /activity/report (a sample a minute per agent, plus an offline backlog). */
  activityReport: { user: 120, ip: 1200 },
} as const satisfies Record<string, RouteRateLimit>;

/** Route limits that depend on whom the request counts against (see RATE_LIMITS). */
export const RateLimit = (limits: RouteRateLimit) => SetMetadata(RATE_LIMIT_KEY, limits);

/**
 * The throttler's limit for a request: the route's @RateLimit for a person or an
 * address (by the same tracker the throttler keys on), else the default.
 */
export function rateLimitFor(
  tracker: (req: Record<string, unknown>) => string,
  fallback: number,
  reflector: Reflector = new Reflector(),
) {
  return (context: ExecutionContext): number => {
    const route = reflector.getAllAndOverride<RouteRateLimit | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!route) return fallback;
    const key = tracker(context.switchToHttp().getRequest());
    return key.startsWith('ip:') ? route.ip : route.user;
  };
}
