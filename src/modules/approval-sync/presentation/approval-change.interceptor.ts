import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request } from 'express';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import {
  ApprovalAction,
  ApprovalChange,
  ApprovalChangedEvent,
  ApprovalWhat,
} from '@shared/events/approval-changed.event';

const ACTION_OF: Record<string, ApprovalAction> = {
  approve: 'DECIDED',
  reject: 'DECIDED',
  revoke: 'REVOKED',
  reopen: 'REOPENED',
  cancel: 'CANCELLED',
};

/** `POST .../:id/<verb>`: one item, named in the path. */
const ONE_ITEM: ReadonlyArray<{ path: RegExp; what: ApprovalWhat }> = [
  { path: /\/breaks\/approvals\/([^/]+)\/(approve|reject|reopen)\/?$/, what: 'BREAK' },
  { path: /\/leave\/requests\/([^/]+)\/(approve|reject|revoke|cancel)\/?$/, what: 'LEAVE' },
  { path: /\/wfh\/requests\/([^/]+)\/(approve|reject|revoke|cancel)\/?$/, what: 'WFH' },
  {
    path: /\/leave\/comp-off\/claims\/([^/]+)\/(approve|reject|revoke|cancel)\/?$/,
    what: 'COMPOFF',
  },
];

/**
 * `POST .../approvals/:type/:id/<verb>`: the unified approvals. 4.0 adds away time,
 * and takes the type in any case.
 */
const UNIFIED = /\/approvals\/(break|meeting|away)\/([^/]+)\/(approve|reject|reopen)\/?$/i;

/** The unified approvals' `type` (path segment or bulk item) as the event names it. */
function whatOfType(type: unknown): ApprovalWhat | null {
  switch (typeof type === 'string' ? type.toLowerCase() : '') {
    case 'break':
      return 'BREAK';
    case 'meeting':
      return 'MEETING';
    case 'away':
      return 'AWAY';
    default:
      return null;
  }
}

/** `POST <path>`: a new item, its id in the answer. */
const NEW_ITEM: ReadonlyArray<{ path: RegExp; what: ApprovalWhat }> = [
  { path: /\/leave\/requests\/?$/, what: 'LEAVE' },
  { path: /\/wfh\/requests\/?$/, what: 'WFH' },
  { path: /\/leave\/comp-off\/claims\/?$/, what: 'COMPOFF' },
  { path: /\/leave\/comp-off\/grants\/?$/, what: 'COMPOFF' },
];

/** Both bulk approvals; only what the answer lists as approved changed. */
const BULK = /\/approvals\/bulk-approve\/?$/;

/** Someone back from a break. One still waiting now reads differently: its overrun, its end. */
const BREAK_END = /\/breaks\/end\/?$/;

/** A live meeting shows in the lists while it runs; its request comes when it ends. */
const MEETING_START = /\/meetings\/start\/?$/;
const MEETING_END = /\/meetings\/(?!status\/)([^/]+)\/end\/?$/;

function bulkItems(data: unknown): ApprovalChange[] {
  const approved = (data as { approved?: unknown } | null | undefined)?.approved;
  if (!Array.isArray(approved)) return [];
  return approved.flatMap((a: unknown): ApprovalChange[] => {
    // /breaks/approvals/bulk-approve answers ids; /approvals/bulk-approve { type, id }.
    if (typeof a === 'string') return [{ what: 'BREAK', id: a, action: 'DECIDED' }];
    const item = a as { type?: unknown; id?: unknown } | null;
    const what = whatOfType(item?.type);
    if (typeof item?.id !== 'string' || !what) return [];
    return [{ what, id: item.id, action: 'DECIDED' }];
  });
}

/** A break that ended and still waits for a decision, from the answer of POST /breaks/end. */
function breakEnded(data: unknown): ApprovalChange[] {
  const record = (data as { record?: { id?: unknown; approvalStatus?: unknown } | null } | null)
    ?.record;
  return typeof record?.id === 'string' && record.approvalStatus === 'PENDING'
    ? [{ what: 'BREAK', id: record.id, action: 'UPDATED' }]
    : [];
}

function meetingStarted(data: unknown): ApprovalChange[] {
  const id = (data as { meeting?: { id?: unknown } | null } | null)?.meeting?.id;
  return typeof id === 'string' ? [{ what: 'MEETING', id, action: 'UPDATED' }] : [];
}

/**
 * What a successful request changed, from its path and its answer (`data` of the
 * envelope). Break, meeting and away requests made outside a decision (a skip, an
 * overrun asked for on a break not yet waiting, a meeting that ended, the auto-skip
 * job, the agent's away pop-up) are announced by their own events instead: see
 * ApprovalSyncSubscriber.
 */
export function approvalChangesOf(method: string, path: string, data: unknown): ApprovalChange[] {
  if (method.toUpperCase() !== 'POST') return [];
  if (BULK.test(path)) return bulkItems(data);
  if (BREAK_END.test(path)) return breakEnded(data);
  if (MEETING_START.test(path)) return meetingStarted(data);
  const ended = MEETING_END.exec(path);
  if (ended) {
    const discarded = (data as { discarded?: unknown } | null)?.discarded === true;
    return discarded ? [{ what: 'MEETING', id: ended[1], action: 'UPDATED' }] : [];
  }
  const unified = UNIFIED.exec(path);
  if (unified) {
    return [
      {
        what: whatOfType(unified[1])!,
        id: unified[2],
        action: ACTION_OF[unified[3].toLowerCase()],
      },
    ];
  }
  for (const { path: re, what } of ONE_ITEM) {
    const m = re.exec(path);
    if (m) return [{ what, id: m[1], action: ACTION_OF[m[2]] }];
  }
  for (const { path: re, what } of NEW_ITEM) {
    if (!re.test(path)) continue;
    const id = (data as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' ? [{ what, id, action: 'CREATED' }] : [];
  }
  return [];
}

/**
 * Every approval request that succeeded publishes ApprovalChangedEvent, so the
 * sync lives beside the decision logic rather than inside it.
 */
@Injectable()
export class ApprovalChangeInterceptor implements NestInterceptor {
  constructor(@Inject(EVENT_BUS) private readonly events: EventBus) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    if (req.method !== 'POST') return next.handle();
    return next.handle().pipe(
      tap((answer: unknown) => {
        const data = (answer as { data?: unknown } | null | undefined)?.data;
        for (const c of approvalChangesOf(req.method, req.path ?? '', data)) {
          void this.events
            .publish(
              ApprovalChangedEvent.eventName,
              new ApprovalChangedEvent(c.what, c.id, c.action),
            )
            .catch(() => undefined);
        }
      }),
    );
  }
}
