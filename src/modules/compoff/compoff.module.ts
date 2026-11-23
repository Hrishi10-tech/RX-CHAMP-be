import { Module } from '@nestjs/common';
import { LeaveModule } from '@modules/leave/leave.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { WorktimeModule } from '@modules/worktime/worktime.module';
import { CompOffJobs } from './application/compoff.jobs';
import { CompOffService } from './application/compoff.service';
import { CompOffController } from './presentation/compoff.controller';

/**
 * Comp off (3.5): extra days worked, claims, approvals and credits by hand. Credits
 * live with leave (the leave module charges comp off leave against them); this
 * module adds what needs the working day: which days were extra and what they earn.
 */
@Module({
  imports: [LeaveModule, ShiftsModule, WorktimeModule],
  controllers: [CompOffController],
  providers: [CompOffService, CompOffJobs],
  exports: [CompOffService],
})
export class CompOffModule {}
