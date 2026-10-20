import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { AwayService } from '../application/away.service';
import { SubmitAwayDto, UnexplainedAwayDto } from '../application/dto/away.dto';

/** The agent's away pop-up (docs/4.0/SPEC.md 2.5, 5.6). */
@ApiTags('away')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('away')
export class AwayController {
  constructor(private readonly away: AwayService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Answer the away pop-up. BREAK: a quick break from the away start ({kind: BREAK, break}). ' +
      'Any other reason: away time waiting for approval ({kind: AWAY, away}). 422 AWAY_FIELDS lists missing fields.',
  })
  async submit(@CurrentUser() me: AuthenticatedUser, @Body() body: SubmitAwayDto) {
    return envelope(await this.away.submit(me, body));
  }

  @Post('unexplained')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Record an unanswered away stretch (End Day with the pop-up open, or shutdown)',
  })
  async unexplained(@CurrentUser() me: AuthenticatedUser, @Body() body: UnexplainedAwayDto) {
    return envelope(
      await this.away.unexplained(me, new Date(body.startedAt), new Date(body.endedAt)),
    );
  }
}
