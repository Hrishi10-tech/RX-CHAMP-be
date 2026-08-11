import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ActivityDayQueryDto, ReportActivityDto } from '../application/dto';
import { ReportActivityUseCase } from '../application/use-cases/report-activity.use-case';
import { EndDayUseCase } from '../application/use-cases/end-day.use-case';
import { StartDayUseCase } from '../application/use-cases/start-day.use-case';
import { GetCurrentActivityUseCase } from '../application/use-cases/get-current-activity.use-case';
import { GetTeamLiveUseCase } from '../application/use-cases/get-team-live.use-case';
import { GetDailyActivityUseCase } from '../application/use-cases/get-daily-activity.use-case';

@ApiTags('activity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('activity')
export class ActivityController {
  constructor(
    private readonly report: ReportActivityUseCase,
    private readonly endDay: EndDayUseCase,
    private readonly startDay: StartDayUseCase,
    private readonly getCurrent: GetCurrentActivityUseCase,
    private readonly getTeamLive: GetTeamLiveUseCase,
    private readonly getDaily: GetDailyActivityUseCase,
  ) {}

  // ---- Employee (agent) endpoints -----------------------------------------

  @Post('report')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Agent reports the current foreground app/website + idle (≈ once a minute). ' +
      'Returns progress against the 9h basis plus a shouldCapture signal the agent ' +
      'uses to decide whether to keep taking screenshots.',
  })
  async reportActivity(@CurrentUser() me: AuthenticatedUser, @Body() body: ReportActivityDto) {
    return envelope(await this.report.execute(me.id, body));
  }

  @Post('end-day')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Agent ends the working day for the signed-in user ("End Day" button). ' +
      'Screenshots stop for the rest of the local day. Idempotent.',
  })
  async endWorkingDay(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.endDay.execute(me.id));
  }

  @Post('start-day')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Agent resumes the working day for the signed-in user ("Start day" button) ' +
      'after an End Day. Re-enables activity, screenshots and attendance for today. ' +
      'Idempotent.',
  })
  async startWorkingDay(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.startDay.execute(me.id));
  }

  @Get('me/current')
  @ApiOperation({ summary: "The signed-in user's current foreground activity" })
  async myCurrent(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.getCurrent.execute(me, me.id));
  }

  @Get('me/today')
  @ApiOperation({ summary: "The signed-in user's activity rollup for today (or ?date=)" })
  async myToday(@CurrentUser() me: AuthenticatedUser, @Query() query: ActivityDayQueryDto) {
    return envelope(await this.getDaily.execute(me, me.id, query.date));
  }

  // ---- Manager endpoints ---------------------------------------------------

  @Get('team/live')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
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
      '(self / manager / admin)',
  })
  async userDaily(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: ActivityDayQueryDto,
  ) {
    return envelope(await this.getDaily.execute(me, userId, query.date));
  }
}
