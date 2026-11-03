import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { envelope } from '@shared/http/envelope';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { AgentHealthService } from '../application/agent-health.service';
import { AgentHealthQueryDto } from '../application/dto/agent-health-query.dto';

@ApiTags('agent-health')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('agent-health')
export class AgentHealthController {
  constructor(private readonly health: AgentHealthService) {}

  @Get()
  // 4.0: Admins too (their organisation); a Manager also needs a view grant (service).
  @Roles(Role.SUPER_ADMIN, Role.SUPER_MANAGER, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary:
      'Is each person’s agent reporting, is their day running, are screenshots arriving (3.3)',
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() q: AgentHealthQueryDto) {
    return envelope(await this.health.list(me, q, new Date()));
  }
}
