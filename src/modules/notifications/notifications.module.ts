import { Module } from '@nestjs/common';
import { NOTIFICATION_REPOSITORY } from './domain/notification.repository';
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository';
import { CompanyAssignedSubscriber } from './application/company-assigned.subscriber';
import { MeetingNoteSharedSubscriber } from './application/meeting-note-shared.subscriber';
import { AgentActivatedSubscriber } from './application/agent-activated.subscriber';
import { ListNotificationsUseCase } from './application/use-cases/list-notifications.use-case';
import {
  CountUnreadNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  MarkNotificationReadUseCase,
} from './application/use-cases/mark-notification-read.use-case';
import { NotificationsController } from './presentation/notifications.controller';
import { NotificationsGateway } from './presentation/notifications.gateway';

@Module({
  controllers: [NotificationsController],
  providers: [
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    NotificationsGateway,
    CompanyAssignedSubscriber,
    MeetingNoteSharedSubscriber,
    AgentActivatedSubscriber,
    ListNotificationsUseCase,
    MarkNotificationReadUseCase,
    MarkAllNotificationsReadUseCase,
    CountUnreadNotificationsUseCase,
  ],
})
export class NotificationsModule {}
