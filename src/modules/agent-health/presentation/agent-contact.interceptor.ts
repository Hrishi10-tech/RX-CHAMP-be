import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { Request } from 'express';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { AgentContactService } from '../application/agent-contact.service';

const AGENT_UA = /^RXVisionAgent\//;

/**
 * Requests only the desktop agent makes (a 3.0 agent sends no User-Agent, so the
 * route is the tell). Matched on the path after the API prefix.
 */
const AGENT_ONLY_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /\/activity\/report\/?$/ },
  { method: 'POST', path: /\/activity\/(start|end)-day\/?$/ },
  { method: 'POST', path: /\/screenshots\/?$/ },
  { method: 'POST', path: /\/presence\/heartbeat\/?$/ },
];

export function isAgentRequest(
  method: string,
  path: string,
  userAgent: string | undefined,
): boolean {
  if (userAgent && AGENT_UA.test(userAgent)) return true;
  const m = method.toUpperCase();
  return AGENT_ONLY_ROUTES.some((r) => r.method === m && r.path.test(path));
}

/**
 * Notes, for every signed-in agent request, that the person's agent is alive.
 * Runs after the guards (so the user is known) and never touches the response.
 */
@Injectable()
export class AgentContactInterceptor implements NestInterceptor {
  constructor(private readonly contacts: AgentContactService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
      const user = req.user;
      const ua = req.headers['user-agent'];
      if (user?.id && isAgentRequest(req.method, req.path ?? '', ua)) {
        this.contacts.touch(user.id, ua ?? null);
      }
    }
    return next.handle();
  }
}
