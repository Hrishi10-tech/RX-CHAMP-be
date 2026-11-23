import { Module } from '@nestjs/common';
import { SettingsModule } from '@modules/settings/settings.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { CalendarModule } from '@modules/calendar/calendar.module';
import { LEAVE_REPOSITORY } from './domain/leave.repository';
import { PrismaLeaveRepository } from './infrastructure/prisma-leave.repository';
import { LeaveAccountsService } from './application/leave-accounts.service';
import { LeaveDaysService } from './application/leave-days.service';
import { LeaveJobs } from './application/leave.jobs';
import { LeaveOverviewService } from './application/leave-overview.service';
import { LeavePeopleService } from './application/leave-people.service';
import { LeavePolicyService } from './application/leave-policy.service';
import { LeaveRequestsService } from './application/leave-requests.service';
import { LeaveController } from './presentation/leave.controller';

/**
 * Leave (3.4): CL/SL and EL/PL balances per person and year, requests with their
 * approval route, quotas, manual adjustments and the policy.
 *
 * Builds on the shifts module (people, working days) and the settings module (the
 * policy is an app setting). The worktime and reports modules read approved leave
 * through LeaveDaysService; nothing here imports them.
 */
@Module({
  // 4.0: the organisation calendar decides working days.
  imports: [ShiftsModule, SettingsModule, CalendarModule],
  controllers: [LeaveController],
  providers: [
    { provide: LEAVE_REPOSITORY, useClass: PrismaLeaveRepository },
    LeavePolicyService,
    LeavePeopleService,
    LeaveAccountsService,
    LeaveRequestsService,
    LeaveOverviewService,
    LeaveDaysService,
    LeaveJobs,
  ],
  exports: [LeaveDaysService, LeavePolicyService, LeaveOverviewService],
})
export class LeaveModule {}
