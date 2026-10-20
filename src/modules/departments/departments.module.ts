import { Module } from '@nestjs/common';
import { SettingsModule } from '@modules/settings/settings.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { DepartmentsService } from './application/departments.service';
import { DepartmentsController } from './presentation/departments.controller';

/** Departments of an organisation (docs/4.0/SPEC.md 2.1, 5.2). */
@Module({
  imports: [SettingsModule, ShiftsModule],
  controllers: [DepartmentsController],
  providers: [DepartmentsService],
  exports: [DepartmentsService],
})
export class DepartmentsModule {}
