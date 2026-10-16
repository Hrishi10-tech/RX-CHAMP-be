import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { CoreModule } from './core/core.module';

import { PrismaModule } from '@shared/database/prisma.module';
import { CacheModule } from '@shared/cache/cache.module';
import { SecurityModule } from '@shared/security/security.module';
import { EventsModule } from '@shared/events/events.module';
import { WebsocketModule } from '@shared/websocket/websocket.module';
import { AppLoggerModule } from '@shared/logger/logger.module';

import { AuthModule } from '@modules/auth/auth.module';
import { UsersModule } from '@modules/users/users.module';
import { RolesModule } from '@modules/roles/roles.module';
import { CompaniesModule } from '@modules/companies/companies.module';
import { NotificationsModule } from '@modules/notifications/notifications.module';
import { PresenceModule } from '@modules/presence/presence.module';
import { ActivityModule } from '@modules/activity/activity.module';
import { AnalyticsModule } from '@modules/analytics/analytics.module';
import { ChatModule } from '@modules/chat/chat.module';
import { ScreenshotsModule } from '@modules/screenshots/screenshots.module';
import { HealthModule } from '@modules/health/health.module';
import { AgentModule } from '@modules/agent/agent.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { SettingsModule } from '@modules/settings/settings.module';
import { WorktimeModule } from '@modules/worktime/worktime.module';
import { ReportsModule } from '@modules/reports/reports.module';

@Module({
  imports: [
    // Drives the nightly refresh-token sweep, the approvals digest and SLA, the
    // auto-close and auto-skip of the working day, and the monthly reports.
    ScheduleModule.forRoot(),
    CoreModule,
    AppLoggerModule,
    PrismaModule,
    CacheModule,
    SecurityModule,
    EventsModule,
    WebsocketModule,
    AuthModule,
    UsersModule,
    RolesModule,
    CompaniesModule,
    NotificationsModule,
    PresenceModule,
    ActivityModule,
    AnalyticsModule,
    ChatModule,
    ScreenshotsModule,
    HealthModule,
    AgentModule,
    ShiftsModule,
    SettingsModule,
    WorktimeModule,
    ReportsModule,
  ],
})
export class AppModule {}
