import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

import configuration from '@shared/config/configuration';
import { validateEnv } from '@shared/config/env.validation';
import { ResponseInterceptor } from '@shared/http/response.interceptor';
import { ReplayInterceptor } from '@shared/http/replay.interceptor';
import { AgentEventsCleanup } from '@shared/http/agent-events.cleanup';
import { AllExceptionsFilter } from '@shared/http/all-exceptions.filter';
import { throttlerOptions } from '@shared/security/throttler-options';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnv,
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: throttlerOptions,
    }),
  ],
  providers: [
    // Offline replay first (outermost): a repeat answers the stored envelope as is.
    { provide: APP_INTERCEPTOR, useClass: ReplayInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    AgentEventsCleanup,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class CoreModule {}
