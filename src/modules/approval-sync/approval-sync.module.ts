import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { PushModule } from '@modules/push/push.module';
import { ApprovalAudienceService } from './application/approval-audience.service';
import { ApprovalSyncSubscriber } from './application/approval-sync.subscriber';
import { ApprovalChangeInterceptor } from './presentation/approval-change.interceptor';

/**
 * Instant sync of approvals (3.6): `approvals:changed` on the /notifications socket
 * whenever a break, meeting, leave, work-from-home or comp off item is created,
 * decided or reopened, and a push to the deciders of each new request. Watches
 * requests and events from outside; the modules that decide never know it is here.
 */
@Module({
  imports: [NotificationsModule, PushModule],
  providers: [
    ApprovalAudienceService,
    ApprovalSyncSubscriber,
    { provide: APP_INTERCEPTOR, useClass: ApprovalChangeInterceptor },
  ],
})
export class ApprovalSyncModule {}
