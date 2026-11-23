import { Module } from '@nestjs/common';
import { LeaveModule } from '@modules/leave/leave.module';
import { SettingsModule } from '@modules/settings/settings.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { WfhDaysService } from './application/wfh-days.service';
import { WfhOverviewService } from './application/wfh-overview.service';
import { WfhPolicyService } from './application/wfh-policy.service';
import { WfhRequestsService } from './application/wfh-requests.service';
import { WfhSchedulesService } from './application/wfh-schedules.service';
import { WFH_REPOSITORY } from './domain/wfh.repository';
import { PrismaWfhRepository } from './infrastructure/prisma-wfh.repository';
import { WfhController } from './presentation/wfh.controller';

/**
 * Work from home (3.5): requests approved on the leave routes, schedules, and the
 * policy. Builds on shifts (working days), leave (people, routes, leave days) and
 * settings. The worktime and reports modules read work from home through
 * WfhDaysService; nothing here imports them.
 */
@Module({
  imports: [ShiftsModule, SettingsModule, LeaveModule],
  controllers: [WfhController],
  providers: [
    { provide: WFH_REPOSITORY, useClass: PrismaWfhRepository },
    WfhPolicyService,
    WfhDaysService,
    WfhRequestsService,
    WfhSchedulesService,
    WfhOverviewService,
  ],
  exports: [WfhDaysService, WfhPolicyService, WfhRequestsService],
})
export class WfhModule {}
