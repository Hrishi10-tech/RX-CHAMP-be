import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { Role } from '@shared/rbac/roles.enum';
import { CompanyAssignedEvent } from '@modules/users/domain/events/company-assigned.event';
import { NOTIFICATION_REPOSITORY, NotificationRepository } from '../domain/notification.repository';
import { NotificationMapper } from './notification.mapper';
import { NotificationsGateway } from '../presentation/notifications.gateway';

@Injectable()
export class CompanyAssignedSubscriber implements OnModuleInit {
  private readonly logger = new Logger(CompanyAssignedSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(NOTIFICATION_REPOSITORY) private readonly notifications: NotificationRepository,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<CompanyAssignedEvent>(CompanyAssignedEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  private async handle(event: CompanyAssignedEvent): Promise<void> {
    if (event.userRole !== Role.MANAGER) return; // notify managers only

    const saved = await this.notifications.create({
      userId: event.userId,
      type: 'COMPANY_ASSIGNED',
      title: 'New company assigned',
      body: `You have been assigned to ${event.companyName}.`,
    });

    this.gateway.emitToUser(event.userId, NotificationMapper.toView(saved));
    this.logger.debug(`notified manager ${event.userId} of company ${event.companyId}`);
  }
}
