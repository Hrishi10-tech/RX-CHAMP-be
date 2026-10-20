import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { monthLockedError } from '@shared/database/month-lock';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { Request } from 'express';
import { Observable, from, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { PrismaService } from '@shared/database/prisma.service';
import { UnprocessableError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { RequestClock } from '@shared/tenancy';
import { errorResponse, ReplayedResponse } from './all-exceptions.filter';
import { REPLAY_DAY_LIMITS, ReplayDayLimits } from './replay-day.port';
import { isOfflineAgent, isReplayRoute, replayKinds } from './replay-routes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An event this close to the server's now is a live action: the server's own time is used. */
const LIVE_WINDOW_MS = 30_000;
/** Ahead of the server by up to this much: treated as live (agent clock skew). */
const MAX_AHEAD_MS = 10 * 60_000;
/** The oldest event replay accepts. */
const MAX_AGE_MS = 7 * 24 * 3_600_000;
/** Events must arrive in order; this much disorder is tolerated. */
const ORDER_TOLERANCE_MS = 60_000;
/** A placeholder left by a crashed request is retried after this long. */
const STALE_PLACEHOLDER_MS = 2 * 60_000;
const IN_PROGRESS = 0;
const IN_PROGRESS_BODY = {
  success: false,
  message: 'This action is still being processed. Try again in a moment.',
  error: { code: 'EVENT_IN_PROGRESS', message: 'This action is still being processed.' },
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type WorkSessionEndReason = 'USER' | 'AUTO_CLOSED';

/** What a reopened auto-closed day looked like before, to put back if the action fails. */
interface Reopened {
  userId: string;
  sessionId: string;
  date: string;
  endedAt: Date;
  endReason: WorkSessionEndReason | null;
  source: string;
  dayEndedAt: Date | null;
}

type Begun =
  | { kind: 'REPEAT'; status: number; body: unknown }
  | { kind: 'NEW'; eventAt: Date; replay: boolean; reopened: Reopened | null };

/**
 * 4.0 offline replay (docs/4.0/SPEC.md 6). A mutating request with
 * `X-Client-Event-Id` (uuid):
 *
 *  - is idempotent per (person, event id): a repeat answers the stored status and
 *    body of the first one (agent_events), so a journal resent after a lost answer
 *    never doubles anything;
 *  - acts at `X-Event-At` (RequestClock) only for the agent actions the 4.0 agent
 *    journals offline (REPLAY_ROUTES), sent by a 4.0 agent, and only when the event
 *    is older than 30 s; X-Event-At must then be at most 10 minutes ahead (ahead
 *    within that is treated as now), at most 7 days old, and not earlier than the
 *    person's previous replayed action (422 EVENT_TIME_INVALID, a final refusal).
 *    Anywhere else X-Event-At is ignored and the request runs at the server's time
 *    (an approval can never be back-dated);
 *  - reopens a working day the server auto-closed while the agent was offline,
 *    when the replayed action happened after that close on the same working day.
 *    The reopened session becomes a REPLAY session, and the reopen is undone when
 *    the action fails, so a refused action leaves the day exactly as it was.
 *
 * Requests without the headers (the portal, 3.x agents) pass through untouched.
 */
@Injectable()
export class ReplayInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ReplayInterceptor.name);

  private limitsRef: ReplayDayLimits | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** The worktime module's day limits, looked up at run time (it imports nothing from here). */
  private limits(): ReplayDayLimits | null {
    if (!this.limitsRef && this.moduleRef) {
      try {
        this.limitsRef = this.moduleRef.get<ReplayDayLimits>(REPLAY_DAY_LIMITS, { strict: false });
      } catch {
        this.limitsRef = null;
      }
    }
    return this.limitsRef;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const header = (name: string) => {
      const v = req.headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const eventId = header('x-client-event-id');
    if (!eventId || !MUTATING.has(req.method) || !req.user) return next.handle();
    const routePath: string = req.route?.path ?? req.path;
    const timed = isReplayRoute(req.method, routePath) && isOfflineAgent(header('user-agent'));
    return from(
      this.begin(
        req.user,
        eventId,
        timed ? header('x-event-at') : undefined,
        req.method,
        routePath,
      ),
    ).pipe(
      mergeMap((begun) => {
        if (begun.kind === 'REPEAT')
          return throwError(() => new ReplayedResponse(begun.status, begun.body));
        const frame = begun.replay
          ? { eventAt: begun.eventAt, clientEventId: eventId }
          : { clientEventId: eventId };
        const run = new Observable<unknown>((sub) =>
          RequestClock.run(frame, () => next.handle().subscribe(sub)),
        );
        return run.pipe(
          mergeMap((value) =>
            from(this.finish(req.user!.id, eventId, 200, value).then(() => value)),
          ),
          catchError((err: unknown) => {
            const { status, body } = errorResponse(err);
            const settle = async () => {
              // A refused or failed action never leaves a day it reopened open.
              if (begun.reopened) await this.restore(begun.reopened);
              // Transient failures (5xx) are not stored: the agent retries them.
              if (status < 500) await this.finish(req.user!.id, eventId, status, body);
              else await this.forget(req.user!.id, eventId);
            };
            return from(settle()).pipe(mergeMap(() => throwError(() => err)));
          }),
        );
      }),
    );
  }

  /**
   * `eventAtHeader` is passed only for an agent action replayed by a 4.0 agent;
   * anything else runs on the server clock.
   */
  private async begin(
    me: AuthenticatedUser,
    eventId: string,
    eventAtHeader: string | undefined,
    method: string,
    routePath: string,
  ): Promise<Begun> {
    if (!UUID.test(eventId)) {
      throw new ValidationError('X-Client-Event-Id must be a UUID.', 'VALIDATION_ERROR');
    }
    const now = new Date();
    let eventAt = eventAtHeader ? new Date(eventAtHeader) : now;
    if (Number.isNaN(eventAt.getTime())) {
      throw new UnprocessableError('X-Event-At must be an ISO 8601 time.', 'EVENT_TIME_INVALID');
    }

    const existing = await this.prisma.agentEvent.findUnique({
      where: { userId_clientEventId: { userId: me.id, clientEventId: eventId } },
    });
    if (existing) {
      if (existing.status !== IN_PROGRESS) {
        return { kind: 'REPEAT', status: existing.status, body: existing.body };
      }
      if (now.getTime() - existing.receivedAt.getTime() < STALE_PLACEHOLDER_MS) {
        return { kind: 'REPEAT', status: 409, body: IN_PROGRESS_BODY };
      }
      // A placeholder left by a crashed request: run it again.
      await this.prisma.agentEvent.deleteMany({
        where: { userId: me.id, clientEventId: eventId, status: IN_PROGRESS },
      });
    }

    const ahead = eventAt.getTime() - now.getTime();
    if (ahead > MAX_AHEAD_MS) {
      throw new UnprocessableError(
        'The action time is in the future. Check the computer clock.',
        'EVENT_TIME_INVALID',
      );
    }
    if (-ahead > MAX_AGE_MS) {
      throw new UnprocessableError('The action is more than 7 days old.', 'EVENT_TIME_INVALID');
    }
    if (ahead > 0) eventAt = now;
    const replay = now.getTime() - eventAt.getTime() > LIVE_WINDOW_MS;
    if (replay) {
      // Order is kept among the replayed agent actions only: other requests with
      // the headers ran at the server time and say nothing about the journal.
      const last = await this.prisma.agentEvent.findFirst({
        where: {
          userId: me.id,
          status: { not: IN_PROGRESS },
          kind: { in: replayKinds(routePath) },
        },
        orderBy: { eventAt: 'desc' },
        select: { eventAt: true },
      });
      if (last && eventAt.getTime() < last.eventAt.getTime() - ORDER_TOLERANCE_MS) {
        throw new UnprocessableError(
          'This action is older than one already applied, so it cannot be replayed.',
          'EVENT_TIME_INVALID',
        );
      }
      // A month locked for payroll never changes: an action dated in it is refused
      // before anything is written.
      const companyId = me.companyId ?? me.orgId ?? null;
      if (companyId) {
        const month = dateKeyInZone(eventAt, appTimezone()).slice(0, 7);
        const locked = await this.prisma.monthLock.findUnique({
          where: { companyId_month: { companyId, month } },
          select: { month: true },
        });
        if (locked) throw monthLockedError(month);
      }
    }

    try {
      await this.prisma.agentEvent.create({
        data: {
          userId: me.id,
          clientEventId: eventId,
          kind: `${method} ${routePath}`.slice(0, 120),
          eventAt,
          status: IN_PROGRESS,
          body: {},
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Two copies raced: the other one is running.
        return { kind: 'REPEAT', status: 409, body: IN_PROGRESS_BODY };
      }
      throw err;
    }
    // Only the copy holding the placeholder may reopen a day.
    let reopened: Reopened | null = null;
    if (replay) {
      try {
        reopened = await this.reopenAutoClosed(me.id, eventAt);
      } catch (err) {
        await this.forget(me.id, eventId);
        throw err;
      }
    }
    return { kind: 'NEW', eventAt, replay, reopened };
  }

  /**
   * The person's latest work session was closed automatically (a missed End Day)
   * before this replayed action, on the same working day: reopen it as a REPLAY
   * session, so the action applies to the day it belongs to. The replayed End Day
   * (or the next automatic close, from the person's last input) closes it again.
   * Returns what it changed, so a failed action can put it back.
   */
  private async reopenAutoClosed(userId: string, eventAt: Date): Promise<Reopened | null> {
    const last = await this.prisma.workSession.findFirst({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      select: {
        id: true,
        date: true,
        startedAt: true,
        endedAt: true,
        endReason: true,
        source: true,
      },
    });
    if (!last || !last.endedAt || last.endReason !== 'AUTO_CLOSED') return null;
    if (eventAt.getTime() <= last.endedAt.getTime()) return null;
    // Same working day: the action is within 20 hours of the session start.
    if (eventAt.getTime() - last.startedAt.getTime() > 20 * 3_600_000) return null;
    const open = await this.prisma.workSession.count({ where: { userId, endedAt: null } });
    if (open) return null;
    // Never past the day's latest end (the limit a late input may move a close
    // to): such an action is refused by the day being closed, and no lazy
    // automatic close runs inside it (re-audit M2).
    const limits = this.limits();
    if (!limits) return null;
    const latestEnd = await limits.latestEndOfSession({
      userId,
      date: last.date,
      startedAt: last.startedAt,
    });
    if (eventAt.getTime() > latestEnd.getTime()) return null;
    const ended = await this.prisma.workDayEnd.findUnique({
      where: { userId_date: { userId, date: last.date } },
      select: { endedAt: true },
    });
    const before: Reopened = {
      userId,
      sessionId: last.id,
      date: last.date,
      endedAt: last.endedAt,
      endReason: last.endReason,
      source: last.source,
      dayEndedAt: ended?.endedAt ?? null,
    };
    await this.prisma.$transaction([
      // endReason stays AUTO_CLOSED while open: should it close by itself again,
      // nothing is announced a second time (WorkSessionsService.closeStale).
      this.prisma.workSession.update({
        where: { id: last.id },
        data: { endedAt: null, source: 'REPLAY' },
      }),
      ...(ended?.endedAt
        ? [
            this.prisma.workDayEnd.update({
              where: { userId_date: { userId, date: last.date } },
              data: { endedAt: null },
            }),
          ]
        : []),
    ]);
    this.logger.log(`reopened auto-closed day ${last.date} of ${userId} for a replayed action`);
    return before;
  }

  /** The replayed action failed: the reopened day goes back to how it was. */
  private async restore(r: Reopened): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.workSession.update({
          where: { id: r.sessionId },
          data: { endedAt: r.endedAt, endReason: r.endReason, source: r.source },
        }),
        ...(r.dayEndedAt
          ? [
              this.prisma.workDayEnd.update({
                where: { userId_date: { userId: r.userId, date: r.date } },
                data: { endedAt: r.dayEndedAt },
              }),
            ]
          : []),
      ]);
      this.logger.log(`closed day ${r.date} of ${r.userId} again: the replayed action failed`);
    } catch (err) {
      this.logger.warn(
        `could not close day ${r.date} of ${r.userId} again: ${(err as Error).message}`,
      );
    }
  }

  private async finish(
    userId: string,
    eventId: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    try {
      await this.prisma.agentEvent.update({
        where: { userId_clientEventId: { userId, clientEventId: eventId } },
        data: { status, body: (body ?? {}) as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.logger.warn(`agent event ${eventId} not stored: ${(err as Error).message}`);
    }
  }

  private async forget(userId: string, eventId: string): Promise<void> {
    await this.prisma.agentEvent
      .deleteMany({ where: { userId, clientEventId: eventId, status: IN_PROGRESS } })
      .catch(() => undefined);
  }
}
