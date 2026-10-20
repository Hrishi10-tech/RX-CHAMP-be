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
import { RequestClock } from '@shared/tenancy';
import { ParseIdPipe } from '@shared/validation/is-id';
import {
  CommentSkipDto,
  SkipBreakDto,
  StartBreakDto,
  StartQuickBreakDto,
} from '@modules/shifts/application/dto/break.dto';
import { SkipsNeedingCommentQuery } from '@modules/shifts/application/skips-needing-comment.query';
import { MyBreaksUseCase } from '@modules/shifts/application/use-cases/my-breaks.use-case';
import { BreakDayView } from '@modules/shifts/application/shifts.types';
import { DEFAULT_REASON_MIN_CHARS } from '@modules/shifts/domain/shift.types';
import { agentGeneration } from '../domain/agent-generation';
import { TeamQueryDto, TeamTodayQueryDto } from '../application/dto/workday.dto';
import { TeamOverviewService } from '../application/team-overview.service';
import { SkipsService } from '../application/skips.service';
import { TeamTodayService } from '../application/team-today.service';
import { WorkSessionsService } from '../application/work-sessions.service';
import { WorkdayService } from '../application/workday.service';
import { HistoryService } from '../application/history.service';
import { HistoryQueryDto } from '../application/dto/workday.dto';

@ApiTags('workday')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('workday')
export class WorkdayController {
  constructor(
    private readonly workday: WorkdayService,
    private readonly history: HistoryService,
  ) {}

  @Get('me/history')
  @ApiOperation({
    summary:
      "4.0: the signed-in person's month: focus against the monthly target from the calendar, " +
      'paid and unpaid breaks, meetings (with the MoM sender), away time and its approvals',
  })
  async myHistory(@CurrentUser() me: AuthenticatedUser, @Query() q: HistoryQueryDto) {
    return envelope(await this.history.month(me, q.month, RequestClock.now()));
  }

  @Get('me/today')
  @ApiOperation({
    summary:
      "The signed-in person's working day: state, sessions, focus time, late start, " +
      'skips waiting for a comment, overdue approvals (any role)',
  })
  async today(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.workday.today(me, new Date()));
  }
}

/**
 * The /breaks routes that need the day's work sessions (3.1). The rest of
 * /breaks (end, history, the old approvals, team) stays in the shifts module.
 */
@ApiTags('breaks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('breaks')
export class WorkdayBreaksController {
  constructor(
    private readonly mine: MyBreaksUseCase,
    private readonly skips: SkipsService,
    private readonly skipsQuery: SkipsNeedingCommentQuery,
    private readonly sessions: WorkSessionsService,
  ) {}

  @Get('me/today')
  @ApiOperation({
    summary:
      "Today's breaks: times, windows, ring, Skip allowed, what was taken or skipped, " +
      'what is running, skips waiting for a comment',
  })
  async today(@CurrentUser() me: AuthenticatedUser) {
    const now = new Date();
    await this.sessions.autoCloseIfStale(me.id, now);
    await this.skips.autoSkipFor(me.id, now, false);
    const base = await this.mine.today(me);
    const view: BreakDayView = {
      ...base,
      skipsNeedingComment: await this.skipsQuery.forUser(me.id, now),
      reasonMinChars: base.shift?.rules.reasonMinChars ?? DEFAULT_REASON_MIN_CHARS,
    };
    return envelope(view);
  }

  @Post('start')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Start a scheduled break (a reason is required when early or late). A 3.1 agent ' +
      'needs an open day (409 DAY_NOT_STARTED); an older agent gets one implicitly.',
  })
  async start(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: StartBreakDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.sessions.ensureOpen(me.id, agentGeneration(userAgent), RequestClock.now());
    return envelope(await this.mine.start(me, body));
  }

  @Post('quick/start')
  @HttpCode(200)
  @ApiOperation({
    summary:
      '4.0: start a quick break of 1..60 minutes (the agent offers 5, 10, 15). 409 ON_BREAK, ' +
      'IN_MEETING, DAY_NOT_STARTED, DAY_ENDED. No approval: pay comes from the allowance.',
  })
  async startQuick(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: StartQuickBreakDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    await this.sessions.ensureOpen(me.id, agentGeneration(userAgent), RequestClock.now());
    return envelope(await this.mine.startQuick(me, body.plannedMin));
  }

  @Post(':id/pause')
  @HttpCode(200)
  @ApiOperation({
    summary: '4.0: pause a running scheduled break (409 NOT_ACTIVE; NOT_PAUSABLE for quick breaks)',
  })
  async pause(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.mine.pause(me, id));
  }

  @Post(':id/resume')
  @HttpCode(200)
  @ApiOperation({
    summary:
      '4.0: resume a paused break while its window is open (409 RESUME_WINDOW_CLOSED, ' +
      'NOT_PAUSED, ON_BREAK, IN_MEETING)',
  })
  async resume(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.mine.resume(me, id));
  }

  @Post('skip')
  @HttpCode(200)
  @ApiOperation({ summary: 'Skip a break while its window is open (a reason is required)' })
  async skip(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: SkipBreakDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return envelope(
      await this.skips.skip(me, body, agentGeneration(userAgent), RequestClock.now()),
    );
  }

  @Post(':id/comment')
  @HttpCode(200)
  @ApiOperation({ summary: 'Add the one comment a skipped break with no reason takes' })
  async comment(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: CommentSkipDto,
  ) {
    return envelope(await this.skips.comment(me, id, body.comment, RequestClock.now()));
  }
}

@ApiTags('team')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('team')
export class TeamController {
  constructor(
    private readonly team: TeamTodayService,
    private readonly teamOverview: TeamOverviewService,
  ) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary:
      '4.0 Team: everyone in scope with live status (WORKING, BREAK, MEETING, AWAY, NOT_STARTED, ' +
      'ENDED), today focus against target, department, online and agent version. Managers need a grant.',
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() q: TeamQueryDto) {
    return envelope(await this.teamOverview.team(me, q, new Date()));
  }

  @Get('today')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary:
      'Team today: status, focus, breaks, meetings, late starts, pending approvals and ' +
      "hourly activity per person (Manager: own reports; Super Admin: everyone or one manager's team)",
  })
  async today(@CurrentUser() me: AuthenticatedUser, @Query() q: TeamTodayQueryDto) {
    return envelope(await this.team.today(me, q, new Date()));
  }
}

/** 4.0 Overview (docs/4.0/SPEC.md 5.4). */
@ApiTags('overview')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('overview')
export class OverviewController {
  constructor(private readonly teamOverview: TeamOverviewService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary:
      'The organisation (Admin) or my departments (Manager): today, approvals, this month against ' +
      'target, departments, needs attention, next holidays, working people per hour',
  })
  async get(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.teamOverview.overview(me, new Date()));
  }
}
