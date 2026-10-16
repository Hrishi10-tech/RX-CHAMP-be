import { Module } from '@nestjs/common';
import { SettingsModule } from '@modules/settings/settings.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { APPROVALS_READER } from './domain/approvals.reader';
import { MEETING_RECORD_REPOSITORY } from './domain/meeting-record.repository';
import { SKIP_REPOSITORY } from './domain/skip.repository';
import { WORK_SESSION_REPOSITORY } from './domain/work-session.repository';
import { WORKTIME_READER } from './domain/worktime.reader';
import { PrismaApprovalsReader } from './infrastructure/prisma-approvals.reader';
import { PrismaMeetingRecordRepository } from './infrastructure/prisma-meeting-record.repository';
import { PrismaSkipRepository } from './infrastructure/prisma-skip.repository';
import { PrismaWorkSessionRepository } from './infrastructure/prisma-work-session.repository';
import { PrismaWorktimeReader } from './infrastructure/prisma-worktime.reader';
import { ApprovalsService } from './application/approvals.service';
import { DayDataService } from './application/day-data.service';
import { HourlyActivityService } from './application/hourly-activity.service';
import {
  ApprovalsDigestJob,
  ApprovalsSlaJob,
  AutoCloseJob,
  AutoSkipJob,
  HourlyCacheJob,
} from './application/jobs/worktime.jobs';
import { MeetingRerouteSubscriber } from './application/meeting-reroute.subscriber';
import { MeetingsService } from './application/meetings.service';
import { PeopleScopeService } from './application/people-scope.service';
import { SkipsService } from './application/skips.service';
import { TeamTodayService } from './application/team-today.service';
import { WorkSessionsService } from './application/work-sessions.service';
import { WorkdayService } from './application/workday.service';
import { ApprovalsController } from './presentation/approvals.controller';
import { MeetingsController } from './presentation/meetings.controller';
import {
  TeamController,
  WorkdayBreaksController,
  WorkdayController,
} from './presentation/workday.controller';

/**
 * The 3.1 working day: work sessions (Start Day to End Day, the implicit legacy
 * session, the missed End Day auto-close), focus time, skips and auto-skips,
 * meetings, the unified approvals with their 48-hour rule, Team today and hourly
 * activity, and the jobs behind them.
 *
 * Builds on the shifts module (schedules, break records, routing) and the
 * settings module; nothing below imports it. The activity module uses it for
 * Start Day, End Day and activity reports; the reports module for its numbers.
 */
@Module({
  imports: [ShiftsModule, SettingsModule],
  controllers: [
    WorkdayController,
    WorkdayBreaksController,
    TeamController,
    MeetingsController,
    ApprovalsController,
  ],
  providers: [
    { provide: WORK_SESSION_REPOSITORY, useClass: PrismaWorkSessionRepository },
    { provide: SKIP_REPOSITORY, useClass: PrismaSkipRepository },
    { provide: MEETING_RECORD_REPOSITORY, useClass: PrismaMeetingRecordRepository },
    { provide: WORKTIME_READER, useClass: PrismaWorktimeReader },
    { provide: APPROVALS_READER, useClass: PrismaApprovalsReader },
    WorkSessionsService,
    SkipsService,
    MeetingsService,
    DayDataService,
    WorkdayService,
    ApprovalsService,
    PeopleScopeService,
    TeamTodayService,
    HourlyActivityService,
    AutoCloseJob,
    AutoSkipJob,
    ApprovalsSlaJob,
    ApprovalsDigestJob,
    HourlyCacheJob,
    MeetingRerouteSubscriber,
  ],
  exports: [
    WorkSessionsService,
    WorkdayService,
    SkipsService,
    MeetingsService,
    DayDataService,
    PeopleScopeService,
    ApprovalsService,
    HourlyActivityService,
    WORK_SESSION_REPOSITORY,
    WORKTIME_READER,
    APPROVALS_READER,
    MEETING_RECORD_REPOSITORY,
  ],
})
export class WorktimeModule {}
