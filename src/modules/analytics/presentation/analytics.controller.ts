import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { GetDashboardAnalyticsUseCase } from '../application/use-cases/get-dashboard-analytics.use-case';

@ApiTags('analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly getDashboard: GetDashboardAnalyticsUseCase) {}

  @Get(':userId')
  @ApiOperation({
    summary:
      "A user's full dashboard analytics for a day: KPIs (with deltas + sparks), " +
      'top apps, timeline, weekly score, focus trend, 7-day heatmap and focus sessions ' +
      '(self / manager / admin).',
  })
  async dashboard(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query('date') date?: string,
  ) {
    return envelope(await this.getDashboard.execute(me, userId, date));
  }
}
