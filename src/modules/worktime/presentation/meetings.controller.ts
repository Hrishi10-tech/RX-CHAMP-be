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
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ParseIdPipe } from '@shared/validation/is-id';
import { agentGeneration } from '../domain/agent-generation';
import {
  LogPastMeetingDto,
  ParticipantsQueryDto,
  StartMeetingDto,
} from '../application/dto/meetings.dto';
import { MeetingsService } from '../application/meetings.service';

@ApiTags('meetings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingsService) {}

  @Post('start')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start a meeting now (agenda and participants); goes to the approver' })
  async start(
    @CurrentUser() me: AuthenticatedUser,
    @Body() body: StartMeetingDto,
    @Headers('user-agent') userAgent?: string,
  ) {
    return envelope(await this.meetings.start(me, body, agentGeneration(userAgent), new Date()));
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
    return envelope(await this.meetings.logPast(me, body, agentGeneration(userAgent), new Date()));
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
    return envelope(await this.meetings.end(me, id, new Date()));
  }
}
