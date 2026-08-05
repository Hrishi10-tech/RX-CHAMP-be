import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { PresenceSummaryQueryDto } from '../application/dto';
import { GetProductivityUseCase } from '../application/use-cases/get-productivity.use-case';

@ApiTags('productivity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('productivity')
export class ProductivityController {
  constructor(private readonly getProductivity: GetProductivityUseCase) {}

  @Get(':userId')
  @ApiOperation({ summary: "A user's heuristic productivity score for a day (self / manager / admin)" })
  async productivity(
    @CurrentUser() me: AuthenticatedUser,
    @Param('userId') userId: string,
    @Query() query: PresenceSummaryQueryDto,
  ) {
    return envelope(await this.getProductivity.execute(me, userId, query.date));
  }
}
