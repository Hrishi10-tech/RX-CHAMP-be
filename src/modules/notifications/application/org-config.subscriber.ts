import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import { WorkdayChangedEvent } from '@shared/events/workday-changed.event';
import { NotificationsGateway } from '../presentation/notifications.gateway';

/**
 * 4.0 live refreshes for agents (docs/4.0/SPEC.md 2.6, 2.7): `config:changed` to
 * every socket of an organisation when its calendar, input tracking or settings
 * change; `workday:changed` to one person when something about their days
 * changed elsewhere (a decision, a replayed offline action).
 */
@Injectable()
export class OrgConfigSubscriber implements OnModuleInit {
  private readonly logger = new Logger(OrgConfigSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<OrgConfigChangedEvent>(OrgConfigChangedEvent.eventName, (e) => {
      try {
        this.gateway.emitConfigChanged(e.companyId, e.kind, e.at);
      } catch (err) {
        this.logger.warn(`config push for ${e.companyId} failed: ${(err as Error).message}`);
      }
    });
    this.events.subscribe<WorkdayChangedEvent>(WorkdayChangedEvent.eventName, (e) => {
      try {
        for (const id of new Set(e.userIds)) this.gateway.emitWorkdayChanged(id, e.reason);
      } catch (err) {
        this.logger.warn(`workday push failed: ${(err as Error).message}`);
      }
    });
  }
}
