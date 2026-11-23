import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NotificationsGateway } from '../presentation/notifications.gateway';

/** Leave decided or changed (published by the leave module). */
const LEAVE_CHANGED = 'leave.changed';
/** A day ended (End Day or the automatic close), published by activity and worktime. */
const DAY_ENDED = 'activity.day-ended';
/** Work from home asked, decided or scheduled (3.5, the wfh module). */
const WFH_CHANGED = 'wfh.changed';
/** Comp off claimed, decided or credited (3.5). */
const COMPOFF_CHANGED = 'compoff.changed';

/**
 * 3.4: passes leave changes and ended days to the person's own devices as
 * `workday:changed` on the /notifications socket, so the phone app refreshes the
 * day at once. WorkdayChangedEvent itself is delivered by OrgConfigSubscriber.
 */
@Injectable()
export class WorkdayChangedSubscriber implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<{ userId: string }>(LEAVE_CHANGED, (e) =>
      this.gateway.emitWorkdayChanged(e.userId, 'LEAVE'),
    );
    this.events.subscribe<{ userId: string }>(DAY_ENDED, (e) =>
      this.gateway.emitWorkdayChanged(e.userId, 'AUTO'),
    );
    this.events.subscribe<{ userId: string }>(WFH_CHANGED, (e) =>
      this.gateway.emitWorkdayChanged(e.userId, 'WFH'),
    );
    this.events.subscribe<{ userId: string }>(COMPOFF_CHANGED, (e) =>
      this.gateway.emitWorkdayChanged(e.userId, 'COMPOFF'),
    );
  }
}
