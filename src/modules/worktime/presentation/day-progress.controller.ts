import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { envelope } from '@shared/http/envelope';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { DayProgressService } from '../application/day-progress.service';

@ApiTags('workday')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class DayProgressController {
  constructor(private readonly progress: DayProgressService) {}

  @Get('day-progress')
  @ApiOperation({
    summary:
      "Today's ring and status (3.6, any role): worked and target time, as the panel shows them, the " +
      'break and meeting running, and when the 2 hour question comes and falls back',
  })
  async dayProgress(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.progress.view(me, new Date()));
  }
}
