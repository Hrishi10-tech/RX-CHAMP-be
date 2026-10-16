import { Module } from '@nestjs/common';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { WorktimeModule } from '@modules/worktime/worktime.module';
import { ACTIVITY_SAMPLE_REPOSITORY } from './domain/activity-sample.repository';
import { ACTIVITY_ACCESS_READER } from './domain/activity-access.reader';
import { WORK_DAY_REPOSITORY } from './domain/work-day.repository';
import { MEETING_WINDOW_READER } from './domain/meeting-window.reader';
import { PrismaActivitySampleRepository } from './infrastructure/prisma-activity-sample.repository';
import { PrismaActivityAccessReader } from './infrastructure/prisma-activity-access.reader';
import { PrismaWorkDayRepository } from './infrastructure/prisma-work-day.repository';
import { PrismaMeetingWindowReader } from './infrastructure/prisma-meeting-window.reader';
import { ReportActivityUseCase } from './application/use-cases/report-activity.use-case';
import { EndDayUseCase } from './application/use-cases/end-day.use-case';
import { StartDayUseCase } from './application/use-cases/start-day.use-case';
import { GetCurrentActivityUseCase } from './application/use-cases/get-current-activity.use-case';
import { GetTeamLiveUseCase } from './application/use-cases/get-team-live.use-case';
import { GetDailyActivityUseCase } from './application/use-cases/get-daily-activity.use-case';
import { EndDayFlow, ReportActivityFlow, StartDayFlow } from './application/flows/workday.flows';
import { ActivityController } from './presentation/activity.controller';
import { ActivityGateway } from './presentation/activity.gateway';

/**
 * Activity samples, the End Day / Start Day buttons and the activity rollups.
 * 3.1: Start Day, End Day and reports go through the work sessions of the
 * worktime module (the flows); the 3.0 use cases remain the building blocks.
 */
@Module({
  imports: [WorktimeModule, ShiftsModule],
  controllers: [ActivityController],
  providers: [
    { provide: ACTIVITY_SAMPLE_REPOSITORY, useClass: PrismaActivitySampleRepository },
    { provide: ACTIVITY_ACCESS_READER, useClass: PrismaActivityAccessReader },
    { provide: WORK_DAY_REPOSITORY, useClass: PrismaWorkDayRepository },
    { provide: MEETING_WINDOW_READER, useClass: PrismaMeetingWindowReader },
    ActivityGateway,
    ReportActivityUseCase,
    EndDayUseCase,
    StartDayUseCase,
    GetCurrentActivityUseCase,
    GetTeamLiveUseCase,
    GetDailyActivityUseCase,
    StartDayFlow,
    EndDayFlow,
    ReportActivityFlow,
  ],
})
export class ActivityModule {}
