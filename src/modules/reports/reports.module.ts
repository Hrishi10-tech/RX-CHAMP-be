import { Module } from '@nestjs/common';
import { SettingsModule } from '@modules/settings/settings.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { WorktimeModule } from '@modules/worktime/worktime.module';
import { MonthLockService } from './application/month-lock.service';
import { ReportRunsService } from './application/report-runs.service';
import { ReportsService } from './application/reports.service';
import { REPORT_STORE } from './domain/report.store';
import { PrismaReportStore } from './infrastructure/prisma-report.store';
import { ReportsController } from './presentation/reports.controller';

/**
 * Attendance and payroll reports (SPEC 1.9, 3.7): person and team, day and
 * month, the Excel export, the monthly runs and the month lock. Reads what the
 * worktime and shifts modules record; nothing imports this module.
 */
@Module({
  imports: [WorktimeModule, ShiftsModule, SettingsModule],
  controllers: [ReportsController],
  providers: [
    { provide: REPORT_STORE, useClass: PrismaReportStore },
    ReportsService,
    MonthLockService,
    ReportRunsService,
  ],
})
export class ReportsModule {}
