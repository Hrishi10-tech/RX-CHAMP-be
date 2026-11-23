import { Module } from '@nestjs/common';
import { SettingsModule } from '@modules/settings/settings.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { WorktimeModule } from '@modules/worktime/worktime.module';
import { BiometricAdminService } from './application/biometric-admin.service';
import { BiometricDaysService } from './application/biometric-days.service';
import { BiometricIngestService } from './application/biometric-ingest.service';
import { BiometricKeysService } from './application/biometric-keys.service';
import { BiometricPullService } from './application/biometric-pull.service';
import { BiometricSettingsService } from './application/biometric-settings.service';
import { BiometricJobs } from './application/biometric.jobs';
import { BIOMETRIC_REPOSITORY } from './domain/biometric.repository';
import { PrismaBiometricRepository } from './infrastructure/prisma-biometric.repository';
import { BiometricIngestController } from './presentation/biometric-ingest.controller';
import { BiometricController } from './presentation/biometric.controller';

/**
 * Biometric attendance (3.5): punches in (push API, pull adapter, CSV, by hand),
 * matched to people by their biometric ID, and a biometric person's day worked out
 * from them. Writes work sessions through the worktime module's tables; nothing
 * there imports this module.
 */
@Module({
  imports: [ShiftsModule, SettingsModule, WorktimeModule],
  controllers: [BiometricIngestController, BiometricController],
  providers: [
    { provide: BIOMETRIC_REPOSITORY, useClass: PrismaBiometricRepository },
    BiometricSettingsService,
    BiometricKeysService,
    BiometricDaysService,
    BiometricIngestService,
    BiometricAdminService,
    BiometricPullService,
    BiometricJobs,
  ],
  exports: [BiometricDaysService],
})
export class BiometricModule {}
