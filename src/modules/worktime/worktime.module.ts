import { Module } from '@nestjs/common';
import { REPLAY_DAY_LIMITS } from '@shared/http/replay-day.port';
import { WORKDAY_GATE } from '@shared/tenancy/workday-gate.port';
import { SettingsModule } from '@modules/settings/settings.module';
import { CalendarModule } from '@modules/calendar/calendar.module';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { APPROVALS_READER } from './domain/approvals.reader';
import { AWAY_REPOSITORY } from './domain/away.repository';
import { MEETING_RECORD_REPOSITORY } from './domain/meeting-record.repository';
import { SKIP_REPOSITORY } from './domain/skip.repository';
import { WORK_SESSION_REPOSITORY } from './domain/work-session.repository';
import { WORKTIME_READER } from './domain/worktime.reader';
import { PrismaApprovalsReader } from './infrastructure/prisma-approvals.reader';
import { PrismaAwayRepository } from './infrastructure/prisma-away.repository';
import { PrismaMeetingRecordRepository } from './infrastructure/prisma-meeting-record.repository';
import { PrismaSkipRepository } from './infrastructure/prisma-skip.repository';
import { PrismaWorkSessionRepository } from './infrastructure/prisma-work-session.repository';
import { PrismaWorktimeReader } from './infrastructure/prisma-worktime.reader';
import { ApprovalsService } from './application/approvals.service';
import { AwayService } from './application/away.service';
import { DayDataService } from './application/day-data.service';
import { DayPlanService } from './application/day-plan.service';
import { HistoryService } from './application/history.service';
import { PersonDaysService } from './application/person-days.service';
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
import { AwayController } from './presentation/away.controller';
import { MeetingsController } from './presentation/meetings.controller';
import {
  OverviewController,
  TeamController,
  WorkdayBreaksController,
  WorkdayController,
} from './presentation/workday.controller';
import { TeamOverviewService } from './application/team-overview.service';

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
  imports: [ShiftsModule, SettingsModule, CalendarModule],
  controllers: [
    WorkdayController,
    WorkdayBreaksController,
    TeamController,
    OverviewController,
    MeetingsController,
    ApprovalsController,
    AwayController,
  ],
  providers: [
    { provide: WORK_SESSION_REPOSITORY, useClass: PrismaWorkSessionRepository },
    // The replay interceptor asks for a day's latest end before it reopens it.
    { provide: REPLAY_DAY_LIMITS, useExisting: WorkSessionsService },
    // Presence (which worktime depends on) asks whether the day is open.
    { provide: WORKDAY_GATE, useExisting: WorkSessionsService },
    { provide: SKIP_REPOSITORY, useClass: PrismaSkipRepository },
    { provide: MEETING_RECORD_REPOSITORY, useClass: PrismaMeetingRecordRepository },
    { provide: WORKTIME_READER, useClass: PrismaWorktimeReader },
    { provide: APPROVALS_READER, useClass: PrismaApprovalsReader },
    { provide: AWAY_REPOSITORY, useClass: PrismaAwayRepository },
    WorkSessionsService,
    SkipsService,
    MeetingsService,
    DayDataService,
    DayPlanService,
    PersonDaysService,
    HistoryService,
    WorkdayService,
    ApprovalsService,
    AwayService,
    PeopleScopeService,
    TeamTodayService,
    TeamOverviewService,
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
    DayPlanService,
    PersonDaysService,
    PeopleScopeService,
    ApprovalsService,
    HourlyActivityService,
    WORK_SESSION_REPOSITORY,
    WORKTIME_READER,
    APPROVALS_READER,
    MEETING_RECORD_REPOSITORY,
    AWAY_REPOSITORY,
  ],
})
export class WorktimeModule {}
