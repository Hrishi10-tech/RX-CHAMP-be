import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerModuleOptions } from '@nestjs/throttler';
import { API_COPY } from '@shared/copy/api-copy';
import { rateLimitFor } from './rate-limits';
import { throttleTracker } from './throttle-tracker';

/** The limit on every route, and what someone past it reads (C-937). */
export function throttlerOptions(config: ConfigService): ThrottlerModuleOptions {
  // Per signed-in person, else per address (see throttle-tracker.ts).
  const tracker = throttleTracker(
    new JwtService({ secret: config.get<string>('jwt.accessSecret') }),
  );
  return {
    throttlers: [
      {
        ttl: config.get<number>('security.rateLimitTtl') ?? 60_000,
        // A route's @RateLimit (person or address, see rate-limits.ts), else the default.
        limit: rateLimitFor(tracker, config.get<number>('security.rateLimitMax') ?? 120),
      },
    ],
    getTracker: tracker,
    errorMessage: API_COPY.rateLimited,
  };
}
