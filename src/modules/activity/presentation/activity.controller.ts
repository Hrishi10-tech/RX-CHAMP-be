import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { RATE_LIMITS, RateLimit } from '@shared/security/rate-limits';
import { ParseIdPipe } from '@shared/validation/is-id';
import { agentGeneration } from '@modules/worktime/domain/agent-generation';
import { DayQueryDto, EndDayDto, StartDayDto } from '@modules/worktime/application/dto/workday.dto';
import { HourlyActivityService } from '@modules/worktime/application/hourly-activity.service';
import { ActivityDayQueryDto, ReportActivityDto } from '../application/dto';
import { EndDayFlow, ReportActivityFlow, StartDayFlow } from '../application/flows/workday.flows';
import { GetCurrentActivityUseCase } from '../application/use-cases/get-current-activity.use-case';
import { GetTeamLiveUseCase } from '../application/use-cases/get-team-live.use-case';
import { GetDailyActivityUseCase } from '../application/use-cases/get-daily-activity.use-case';

@ApiTags('activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('activity')
export class ActivityController {
  constructor(
    private readonly report: ReportActivityFlow,
    private readonly endDay: EndDayFlow,
    private readonly startDay: StartDayFlow,
    private readonly getCurrent: GetCurrentActivityUseCase,
    private readonly getTeamLive: GetTeamLiveUseCase,
    private readonly getDaily: GetDailyActivityUseCase,
    private readonly hourly: HourlyActivityService,
  ) {}

  // ---- Employee (agent) endpoints -----------------------------------------

  @Post('report')
  @HttpCode(200)
  @RateLimit(RATE_LIMITS.activityReport)
  @ApiOperation({
    summary:
      'Agent reports the current foreground app/website + idle (≈ once a minute). ' +
      'shouldCapture is true only while a work session is open (3.1 agents); an older ' +
      "agent's first active sample of the day opens one implicitly.",
  })
  async reportActivity(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: ReportActivityDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return envelope(await this.report.execute(me, body, agentGeneration(userAgent), new Date()));
  }

  @Post('end-day')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'End Day: saves skip comments, auto-skips owed breaks, applies the 3.1 gates ' +
      '(SKIP_COMMENTS_REQUIRED, APPROVALS_OVERDUE), closes the work session. Idempotent.',
  })
  async endWorkingDay(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: EndDayDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return envelope(await this.endDay.execute(me, body, agentGeneration(userAgent), new Date()));
  }

  @Post('start-day')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Start Day: opens a work session (or returns the open one); after End Day it resumes ' +
      'the same day as a second session. Idempotent.',
  })
  async startWorkingDay(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: StartDayDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return envelope(await this.startDay.execute(me, body, agentGeneration(userAgent), new Date()));
  }

  @Get('me/current')
  @ApiOperation({ summary: "The signed-in user's current foreground activity" })
  async myCurrent(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.getCurrent.execute(me, me.id));
  }

  @Get('me/today')
  @ApiOperation({
    summary:
      "The signed-in user's activity rollup for today (or ?date=). Staff get the same shape " +
      'with every activity figure emptied.',
  })
  async myToday(@CurrentUser() me: AuthenticatedUser, @Query() query: ActivityDayQueryDto) {
    return envelope(await this.getDaily.execute(me, me.id, query.date));
  }

  // ---- Manager endpoints ---------------------------------------------------

  @Get('team/live')
  @Roles(Role.MANAGER, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'What every report is using right now (manager)' })
  async teamLive(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.getTeamLive.execute(me.id));
  }

  @Get('user/:userId/current')
  @ApiOperation({ summary: "A user's current foreground activity (self / manager / admin)" })
  async userCurrent(@CurrentUser() me: AuthenticatedUser, @Param('userId') userId: string) {
    return envelope(await this.getCurrent.execute(me, userId));
  }

  @Get('user/:userId/daily')
  @ApiOperation({
    summary:
      "A user's day rollup: top apps, top websites, active/idle, hourly split, clock in/out " +
      '(self / manager / admin; emptied for staff)',
  })
  async userDaily(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: ActivityDayQueryDto,
  ) {
    return envelope(await this.getDaily.execute(me, userId, query.date));
  }

  @Get('user/:userId/hourly')
  @Roles(Role.MANAGER, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      "One person's active minutes per hour and quiet hours for a day (Manager: own " +
      'reports; Super Admin: anyone; staff 403)',
  })
  async userHourly(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId', new ParseIdPipe()) userId: string,
    @Query() query: DayQueryDto,
  ) {
    return envelope(await this.hourly.forUser(me, userId, query.date, new Date()));
  }
}
