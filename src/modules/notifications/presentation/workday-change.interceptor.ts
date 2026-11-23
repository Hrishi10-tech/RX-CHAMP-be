import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { WorkdayChangedEvent } from '@shared/events/workday-changed.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';

/**
 * Requests that change the caller's own working day (3.4), matched on the path
 * after the API prefix. A successful one publishes WorkdayChangedEvent.
 */
const CHANGES: ReadonlyArray<{ path: RegExp; what: string }> = [
  { path: /\/activity\/(start|end)-day\/?$/, what: 'DAY' },
  { path: /\/workday\/me\/late-reason\/?$/, what: 'DAY' },
  { path: /\/workday\/me\/wfh\/(start|end)\/?$/, what: 'DAY' },
  { path: /\/breaks\/(start|end|skip)\/?$/, what: 'BREAK' },
  { path: /\/presence\/(start|end)\/?$/, what: 'PRESENCE' },
  { path: /\/meetings\/(start|past)\/?$/, what: 'MEETING' },
  { path: /\/meetings\/[^/]+\/end\/?$/, what: 'MEETING' },
];

export function workdayChangeOf(method: string, path: string): string | null {
  if (method.toUpperCase() !== 'POST') return null;
  return CHANGES.find((c) => c.path.test(path))?.what ?? null;
}

@Injectable()
export class WorkdayChangeInterceptor implements NestInterceptor {
  constructor(@Inject(EVENT_BUS) private readonly events: EventBus) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const what = workdayChangeOf(req.method, req.path ?? '');
    const userId = req.user?.id;
    if (!what || !userId) return next.handle();
    return next.handle().pipe(
      tap(() => {
        void this.events
          .publish(WorkdayChangedEvent.eventName, new WorkdayChangedEvent([userId], what))
          .catch(() => undefined);
      }),
    );
  }
}
