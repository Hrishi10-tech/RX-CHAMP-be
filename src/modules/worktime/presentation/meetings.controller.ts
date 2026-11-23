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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ParseIdPipe } from '@shared/validation/is-id';
import { agentGeneration, isAgent40 } from '../domain/agent-generation';
import { RequestClock } from '@shared/tenancy';
import { StrictBody } from '@shared/validation/strict-body';

import { DayProgressService } from '../application/day-progress.service';
import {
  LogPastMeetingDto,
  ParticipantsQueryDto,
  StartMeetingDto,
  StartStatusMeetingDto,
  StatusMeetingActionDto,
} from '../application/dto/meetings.dto';
import { MeetingsService } from '../application/meetings.service';

@ApiTags('meetings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('meetings')
export class MeetingsController {
  constructor(
    private readonly meetings: MeetingsService,
    private readonly progress: DayProgressService,
  ) {}

  // ---- The "In a meeting" status (3.6). Before :id/end, which would take "status" as an id.

  @Post('status/start')
  @HttpCode(200)
  @ApiBody({ type: StartStatusMeetingDto })
  @ApiOperation({
    summary:
      'In a meeting (3.6), from the button or a suggestion the person tapped. No agenda, no participants, ' +
      'no approval: only start and end travel, and any other field is refused (400). Needs an open day. ' +
      '409 DAY_NOT_STARTED, DAY_ENDED, ON_BREAK, MEETING_IN_PROGRESS, ATTENDANCE_BY_BIOMETRIC. Answers the day progress',
  })
  async statusStart(
    @CurrentUser() me: AuthenticatedUser,
    @StrictBody() body: StartStatusMeetingDto,
  ) {
    await this.meetings.statusStart(me, body.source, RequestClock.now());
    return envelope(await this.progress.view(me, new Date()));
  }

  @Post('status/end')
  @HttpCode(200)
  @ApiOperation({
    summary: 'End meeting (3.6): back to Working. Safe to repeat. Answers the day progress',
  })
  async statusEnd(
    @CurrentUser() me: AuthenticatedUser,
    @StrictBody() _body: StatusMeetingActionDto,
  ) {
    await this.meetings.statusEnd(me, RequestClock.now());
    return envelope(await this.progress.view(me, new Date()));
  }

  @Post('status/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Still in it (3.6): the 2 hours start again from now. After the 10 minute fallback the person is ' +
      'already back to Working, and the answer says so. Answers the day progress',
  })
  async statusConfirm(
    @CurrentUser() me: AuthenticatedUser,
    @StrictBody() _body: StatusMeetingActionDto,
  ) {
    await this.meetings.statusConfirm(me, RequestClock.now());
    return envelope(await this.progress.view(me, new Date()));
  }

  @Post('start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a meeting now (agenda and participants); goes to the approver' })
  async start(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: StartMeetingDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return envelope(
      await this.meetings.start(me, body, agentGeneration(userAgent), RequestClock.now(), {
        agent40: isAgent40(userAgent),
      }),
    );
  }

  @Post('past')
  @HttpCode(200)
  @ApiOperation({
    summary: "Log a meeting that already happened today (inside today's working time)",
  })
  async past(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: LogPastMeetingDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return envelope(
      await this.meetings.logPast(me, body, agentGeneration(userAgent), RequestClock.now(), {
        agent40: isAgent40(userAgent),
      }),
    );
  }

  @Get('me/today')
  @ApiOperation({ summary: "The signed-in person's meetings today" })
  async today(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.meetings.today(me, new Date()));
  }

  @Get('participants')
  @ApiOperation({ summary: 'Active people in your company matching a name (max 50)' })
  async participants(@CurrentUser() me: AuthenticatedUser, @Query() q: ParticipantsQueryDto) {
    return envelope(await this.meetings.participants(me, q.q));
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiOperation({ summary: 'End a live meeting (idempotent); one under a minute is discarded' })
  async end(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.meetings.end(me, id, RequestClock.now()));
  }
}
