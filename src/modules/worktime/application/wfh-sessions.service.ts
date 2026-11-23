import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError } from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { personName } from '@modules/shifts/application/break-events.service';
import { ShiftDayResolver } from '@modules/shifts/application/shift-day.resolver';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import { WfhDaysService } from '@modules/wfh/application/wfh-days.service';
import { wfhOn } from '@modules/wfh/domain/wfh';
import { MOBILE_WFH_SOURCE } from '../domain/day';
import {
  LAST_ENDED_WITHIN_MS,
  WORK_SESSION_REPOSITORY,
  WorkSessionRepository,
} from '../domain/work-session.repository';
import { WorkdayService } from './workday.service';
import { WorkdayTodayView } from './worktime.types';

/**
 * Work from home on the phone (3.5): "Start your day" and "End your day" for
 * biometric staff on an approved or scheduled work-from-home day. Agent staff work
 * from home on the desktop app as on any day; nothing changes for them.
 */
@Injectable()
export class WfhSessionsService {
  private readonly logger = new Logger(WfhSessionsService.name);

  constructor(
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly dayKeys: ShiftDayResolver,
    private readonly wfhDays: WfhDaysService,
    private readonly workday: WorkdayService,
  ) {}

  /** POST /workday/me/wfh/start */
  async start(
    me: AuthenticatedUser,
    now: Date,
  ): Promise<{ resumed: boolean; workday: WorkdayTodayView }> {
    const person = await this.people.findById(me.id);
    if (person?.attendanceSource !== 'BIOMETRIC') {
      throw new ConflictError(
        'Your desktop app tracks your day, at home too: start it there.',
        'ATTENDANCE_BY_AGENT',
      );
    }
    const open = await this.sessions.findOpen(me.id);
    if (open?.source === MOBILE_WFH_SOURCE) {
      return { resumed: false, workday: await this.workday.view(me, now) };
    }
    if (open) {
      throw new ConflictError(
        'You are checked in at the office. Your work from home can start after you check out.',
        'CHECKED_IN_AT_OFFICE',
      );
    }
    const dayOf = await this.dayKeys.keyFnFor(me.id);
    const today = dayOf(now);
    const wfh = wfhOn(await this.wfhDays.byDay([me.id], today, today), me.id, today);
    if (!wfh.mask) {
      throw new ConflictError(
        wfh.pendingMask
          ? 'Your work from home today is still waiting for approval.'
          : 'You have no approved work from home today. Ask for it in the Work from home tab.',
        wfh.pendingMask ? 'WFH_PENDING' : 'WFH_NOT_APPROVED',
      );
    }
    const result = await this.sessions.startDay(me.id, now, now, 'MOBILE_WFH', dayOf);
    this.logger.log(
      `wfh day ${result.resumed ? 'resumed' : 'started'} by ${me.id} on ${result.session.date}`,
    );
    return { resumed: result.resumed, workday: await this.workday.view(me, now) };
  }

  /** POST /workday/me/wfh/end */
  async end(
    me: AuthenticatedUser,
    now: Date,
  ): Promise<{ endedAt: string; workday: WorkdayTodayView }> {
    const open = await this.sessions.findOpen(me.id);
    if (!open || open.source !== MOBILE_WFH_SOURCE) {
      throw new ConflictError('You have no work-from-home day running.', 'WFH_NOT_RUNNING');
    }
    const result = await this.sessions.endDay(
      me.id,
      now,
      open.date,
      false,
      new Date(now.getTime() - LAST_ENDED_WITHIN_MS),
    );
    if (result.kind === 'NOT_STARTED') {
      throw new ConflictError('You have no work-from-home day running.', 'WFH_NOT_RUNNING');
    }
    if (result.kind !== 'ALREADY_ENDED' && result.newlyEnded) {
      const person = await this.people.findById(me.id);
      await this.events
        .publish(
          DayEndedEvent.eventName,
          new DayEndedEvent(
            me.id,
            person ? personName(person) : 'A team member',
            person?.managerId ?? null,
            result.date,
            result.endedAt,
          ),
        )
        .catch(() => undefined);
    }
    return {
      endedAt: result.endedAt.toISOString(),
      workday: await this.workday.view(me, now, result.date),
    };
  }
}
