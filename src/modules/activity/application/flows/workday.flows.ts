import { Injectable } from '@nestjs/common';
import { ConflictError, UnprocessableError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { PresenceBridge } from '@modules/shifts/application/presence-bridge.service';
import { AgentGeneration } from '@modules/worktime/domain/agent-generation';
import { boundedStartedAt } from '@modules/worktime/domain/meetings';
import { SkipsService } from '@modules/worktime/application/skips.service';
import { WorkSessionsService } from '@modules/worktime/application/work-sessions.service';
import { WorkdayService } from '@modules/worktime/application/workday.service';
import { EndDayResponse, StartDayResponse } from '@modules/worktime/application/worktime.types';
import { EndDayDto, StartDayDto } from '@modules/worktime/application/dto/workday.dto';
import { ReportActivityDto } from '../dto';
import { LOCK_SCREEN_APP } from '../activity.constants';
import { ActivityAck } from '../activity.types';
import { redactAck, seesOwnActivity } from '../activity-redaction';
import { EndDayUseCase } from '../use-cases/end-day.use-case';
import { ReportActivityUseCase, sampleInstant } from '../use-cases/report-activity.use-case';
import { StartDayUseCase } from '../use-cases/start-day.use-case';

/**
 * POST /activity/start-day (SPEC 3.1): opens a work session unless one is open
 * (idempotent), reopens the day for every 3.0 reader, announces it.
 */
@Injectable()
export class StartDayFlow {
  constructor(
    private readonly sessions: WorkSessionsService,
    private readonly workday: WorkdayService,
    private readonly startDay: StartDayUseCase,
    private readonly presence: PresenceBridge,
  ) {}

  async execute(
    me: AuthenticatedUser,
    dto: StartDayDto,
    generation: AgentGeneration,
    now: Date,
  ): Promise<StartDayResponse> {
    const result = await this.sessions.startDay(
      me.id,
      boundedStartedAt(dto.startedAt, now),
      generation,
      now,
    );
    if (result.opened) {
      await this.startDay.announce(me.id, result.session.date, now);
      void this.presence.broadcast(me.id, null, now);
    }
    return {
      ok: true,
      date: result.session.date,
      resumed: result.resumed,
      workday: await this.workday.view(me, now),
    };
  }
}

/**
 * POST /activity/end-day (SPEC 3.1): save the comments (all or nothing), the
 * overdue-approvals gate (3.1 agents only), materialise skips (owed windows that
 * closed, and owed windows still open now), the skip-comment gate (3.1 agents
 * only), close the open session, then the 3.0 End Day behaviour. Idempotent once
 * the day is ended.
 */
@Injectable()
export class EndDayFlow {
  constructor(
    private readonly sessions: WorkSessionsService,
    private readonly skips: SkipsService,
    private readonly workday: WorkdayService,
    private readonly endDay: EndDayUseCase,
  ) {}

  async execute(
    me: AuthenticatedUser,
    dto: EndDayDto,
    generation: AgentGeneration,
    now: Date,
  ): Promise<EndDayResponse> {
    await this.sessions.autoCloseIfStale(me.id, now);
    // Everything is judged before anything is written, so a refused End Day leaves
    // no comment, no auto-skip, no notice and no End Day mark behind (re-audit M1):
    // the comments (on existing skips and on the auto-skips this End Day would
    // create, by the ids they will get), then, for a 3.1+ agent with the day open,
    // a Manager's overdue approvals and the skip-comment gate. An already ended day
    // answers as it is, gates or not (idempotent).
    const open = await this.sessions.findOpen(me.id);
    if (open && open.startedAt.getTime() > now.getTime()) {
      throw new UnprocessableError(
        'This End Day is older than the start of the open working day.',
        'EVENT_TIME_INVALID',
      );
    }
    const planned = await this.skips.planAutoSkipsFor(me.id, now, true);
    const comments = await this.skips.checkEndDayComments(me, dto.comments ?? [], planned);
    const gated = generation === 'AGENT_31' && !!open;
    if (gated) {
      await this.workday.assertNoOverdueApprovals(me, now);
      await this.workday.assertSkipsCommented(
        me,
        now,
        await this.skips.plannedNeedingComment(planned),
        new Set(comments.map((c) => c.id)),
      );
    }
    await this.skips.createPlanned(planned, now);
    await this.skips.writeEndDayComments(me, comments, now);
    const result = await this.sessions.endDay(me.id, generation, now);
    if (result.kind === 'NOT_STARTED') {
      throw new ConflictError(
        'Your day has not started, so there is nothing to end.',
        'DAY_NOT_STARTED',
      );
    }
    if (result.kind !== 'ALREADY_ENDED' && result.newlyEnded) {
      await this.endDay.finish(me.id, result.date, result.endedAt);
    }
    return {
      ok: true,
      date: result.date,
      endedAt: result.endedAt.toISOString(),
      // The day that was just ended (its date, ENDED, its focus), even when now is
      // already the next working day: after midnight, or after a night shift.
      workday: await this.workday.view(me, now, result.kind === 'MARKED' ? undefined : result.date),
    };
  }
}

/**
 * POST /activity/report (SPEC 3.1): capture only while a session is open. A 3.1
 * agent with no open session tracks nothing (not stored, shouldCapture false).
 *
 * 4.0 backlog: a sample of time the open session does not cover (none is open, or
 * it was taken before the open one started: the agent drains today's Start Day
 * before yesterday's samples) is history. It is stored as its day's evidence when
 * it falls inside one of the person's closed sessions, or, from a 4.x agent, when
 * it is a later input of a day the server auto-closed before the backlog arrived
 * (the close moves to it, within the day's latest end, and the session becomes a
 * REPLAY one). Anything else of that kind is not stored.
 *
 * An older agent's first active sample of today opens the session implicitly
 * (source LEGACY); its capture keeps the 3.0 rule (on until the day is ended),
 * because those agents treat shouldCapture=false as End Day.
 */
@Injectable()
export class ReportActivityFlow {
  constructor(
    private readonly sessions: WorkSessionsService,
    private readonly report: ReportActivityUseCase,
  ) {}

  async execute(
    me: AuthenticatedUser,
    body: ReportActivityDto,
    generation: AgentGeneration,
    now: Date,
    offlineAgent = false,
  ): Promise<ActivityAck> {
    const ack = await this.ack(me, body, generation, now, offlineAgent);
    // Staff never see activity (SPEC 1.8): the ack keeps its shape, without active time.
    return seesOwnActivity(me.role) ? ack : redactAck(ack);
  }

  private async ack(
    me: AuthenticatedUser,
    body: ReportActivityDto,
    generation: AgentGeneration,
    now: Date,
    offlineAgent: boolean,
  ): Promise<ActivityAck> {
    await this.sessions.autoCloseIfStale(me.id, now);
    const open = await this.sessions.findOpen(me.id);
    const idle = body.idle === true || body.locked === true || body.app?.trim() === LOCK_SCREEN_APP;
    if (generation === 'AGENT_31') {
      const at = sampleInstant(body.at, now);
      if (!open || at.getTime() < open.startedAt.getTime()) {
        const late =
          at.getTime() < now.getTime() &&
          ((await this.sessions.workedAt(me.id, at)) ||
            (offlineAgent && !idle && (await this.sessions.extendAutoClosed(me.id, at))));
        if (late) return this.report.execute(me.id, body, { late: true });
        if (!open) return this.report.ackWithoutStoring(me.id, now);
      }
    } else if (!open && !idle) {
      await this.sessions.openImplicitForSample(me.id, sampleInstant(body.at, now), now);
    }
    return this.report.execute(me.id, body);
  }
}
