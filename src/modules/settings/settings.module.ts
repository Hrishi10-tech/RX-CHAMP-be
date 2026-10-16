import { Module } from '@nestjs/common';
import { SETTINGS_STORE } from './domain/settings.store';
import { PrismaSettingsStore } from './infrastructure/prisma-settings.store';
import { AppSettingsService } from './application/app-settings.service';
import { SettingsController } from './presentation/settings.controller';

/**
 * Organisation settings (SPEC 1.10). Depends on nothing but the database, so every
 * other module may import it.
 */
@Module({
  controllers: [SettingsController],
  providers: [{ provide: SETTINGS_STORE, useClass: PrismaSettingsStore }, AppSettingsService],
  exports: [AppSettingsService],
})
export class SettingsModule {}
