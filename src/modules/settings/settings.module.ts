import { Module } from '@nestjs/common';
import { SETTINGS_STORE } from './domain/settings.store';
import { PrismaSettingsStore } from './infrastructure/prisma-settings.store';
import { AppSettingsService } from './application/app-settings.service';
import { IdleSettingsService } from './application/idle-settings.service';
import { SettingsController } from './presentation/settings.controller';
import { IdleSettingsController } from './presentation/idle-settings.controller';

/**
 * Organisation settings (SPEC 1.10) and input-tracking settings (4.0 SPEC 2.5).
 * Depends on nothing but the database and the event bus, so every other module
 * may import it.
 */
@Module({
  controllers: [SettingsController, IdleSettingsController],
  providers: [
    { provide: SETTINGS_STORE, useClass: PrismaSettingsStore },
    AppSettingsService,
    IdleSettingsService,
  ],
  exports: [AppSettingsService, IdleSettingsService],
})
export class SettingsModule {}
