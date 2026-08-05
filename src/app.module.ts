import { Module } from '@nestjs/common';

import { CoreModule } from './core/core.module';

import { PrismaModule } from '@shared/database/prisma.module';
import { CacheModule } from '@shared/cache/cache.module';
import { SecurityModule } from '@shared/security/security.module';
import { EventsModule } from '@shared/events/events.module';
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

@Module({
  imports: [
    CoreModule,
    AppLoggerModule,
    PrismaModule,
    CacheModule,
    SecurityModule,
    EventsModule,
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
  ],
})
export class AppModule {}
