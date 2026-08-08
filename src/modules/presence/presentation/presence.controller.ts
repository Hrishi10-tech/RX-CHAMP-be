import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import {
  HeartbeatDto,
  PresenceSummaryQueryDto,
  StartPresenceDto,
  UserHistoryQueryDto,
} from '../application/dto';
import { StartPresenceUseCase } from '../application/use-cases/start-presence.use-case';
import { EndPresenceUseCase } from '../application/use-cases/end-presence.use-case';
import { HeartbeatUseCase } from '../application/use-cases/heartbeat.use-case';
import { GetCurrentPresenceUseCase } from '../application/use-cases/get-current-presence.use-case';
import { GetMyTodayUseCase } from '../application/use-cases/get-my-today.use-case';
import { GetTeamLiveUseCase } from '../application/use-cases/get-team-live.use-case';
import { GetTeamSummaryUseCase } from '../application/use-cases/get-team-summary.use-case';
import { GetUserHistoryUseCase } from '../application/use-cases/get-user-history.use-case';
import { GetUserTimelineUseCase } from '../application/use-cases/get-user-timeline.use-case';

@ApiTags('presence')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('presence')
export class PresenceController {
  constructor(
    private readonly startPresence: StartPresenceUseCase,
    private readonly endPresence: EndPresenceUseCase,
    private readonly heartbeat: HeartbeatUseCase,
    private readonly getCurrent: GetCurrentPresenceUseCase,
    private readonly getMyToday: GetMyTodayUseCase,
    private readonly getTeamLive: GetTeamLiveUseCase,
    private readonly getTeamSummary: GetTeamSummaryUseCase,
    private readonly getUserHistory: GetUserHistoryUseCase,
    private readonly getUserTimeline: GetUserTimelineUseCase,
  ) {}

  // ---- Employee (agent) endpoints -----------------------------------------

  @Post('start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a break / lunch / meeting (closes any current status)' })
  async start(@CurrentUser() me: AuthenticatedUser, @Body() body: StartPresenceDto) {
    return envelope(await this.startPresence.execute(me.id, body));
  }

  @Post('end')
  @HttpCode(200)
  @ApiOperation({ summary: 'End the current status — back to working' })
  async end(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.endPresence.execute(me.id));
  }

  @Post('heartbeat')
  @HttpCode(200)
  @ApiOperation({ summary: 'Agent online heartbeat (records/extends online time)' })
  async beat(@CurrentUser() me: AuthenticatedUser, @Body() body: HeartbeatDto) {
    await this.heartbeat.execute(me.id, body.idle ?? false);
    return envelope({ ok: true });
  }

  @Get('me/current')
  @ApiOperation({ summary: "The signed-in user's current status + elapsed time" })
  async current(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.getCurrent.execute(me.id));
  }

  @Get('me/today')
  @ApiOperation({ summary: "The signed-in user's totals + sessions for today" })
  async today(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.getMyToday.execute(me.id));
  }

  // ---- Manager endpoints ---------------------------------------------------

  @Get('team/live')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Live status of every report (manager)' })
  async teamLive(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.getTeamLive.execute(me.id));
  }

  @Get('team/summary')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Day-wise break/lunch/meeting totals per report (manager)' })
  async teamSummary(@CurrentUser() me: AuthenticatedUser, @Query() query: PresenceSummaryQueryDto) {
    const { date, rows } = await this.getTeamSummary.execute(me.id, query.date);
    return envelope(rows, { meta: { date } });
  }

  @Get('team/:userId/history')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: "One report's day-wise totals over the last N days (worked-hours trend)",
  })
  async userHistory(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: UserHistoryQueryDto,
  ) {
    return envelope(await this.getUserHistory.execute(me.id, userId, query.days ?? 7));
  }

  @Get('team/:userId/timeline')
  @Roles(Role.MANAGER, Role.ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: "One report's day split into hourly work/break/lunch/meeting buckets" })
  async userTimeline(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: PresenceSummaryQueryDto,
  ) {
    return envelope(await this.getUserTimeline.execute(me.id, userId, query.date));
  }
}
