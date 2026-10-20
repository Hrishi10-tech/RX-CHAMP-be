import { Module } from '@nestjs/common';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { NOTIFICATION_REPOSITORY } from './domain/notification.repository';
import { OversightRecipients } from './application/oversight-recipients.service';
import { PrismaNotificationRepository } from './infrastructure/prisma-notification.repository';
import { CompanyAssignedSubscriber } from './application/company-assigned.subscriber';
import { MeetingNoteSharedSubscriber } from './application/meeting-note-shared.subscriber';
import { AgentActivatedSubscriber } from './application/agent-activated.subscriber';
import { DayEndedSubscriber } from './application/day-ended.subscriber';
import { ChatMessageSubscriber } from './application/chat-message.subscriber';
import { BreakEventsSubscriber } from './application/break-events.subscriber';
import { OrgConfigSubscriber } from './application/org-config.subscriber';
import { NoticeSubscriber } from './application/notice.subscriber';
import { ListNotificationsUseCase } from './application/use-cases/list-notifications.use-case';
import {
  CountUnreadNotificationsUseCase,
  MarkAllNotificationsReadUseCase,
  MarkNotificationReadUseCase,
} from './application/use-cases/mark-notification-read.use-case';
import { NotificationsController } from './presentation/notifications.controller';
import { NotificationsGateway } from './presentation/notifications.gateway';

@Module({
  // 4.0: SHIFT_PEOPLE_READER resolves department managers and organisation Admins.
  imports: [ShiftsModule],
  controllers: [NotificationsController],
  providers: [
    { provide: NOTIFICATION_REPOSITORY, useClass: PrismaNotificationRepository },
    OversightRecipients,
    NotificationsGateway,
    CompanyAssignedSubscriber,
    MeetingNoteSharedSubscriber,
    AgentActivatedSubscriber,
    DayEndedSubscriber,
    ChatMessageSubscriber,
    BreakEventsSubscriber,
    NoticeSubscriber,
    OrgConfigSubscriber,
    ListNotificationsUseCase,
    MarkNotificationReadUseCase,
    MarkAllNotificationsReadUseCase,
    CountUnreadNotificationsUseCase,
  ],
})
export class NotificationsModule {}
