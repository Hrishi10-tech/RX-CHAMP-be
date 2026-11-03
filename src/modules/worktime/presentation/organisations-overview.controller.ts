import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { IsId } from '@shared/validation/is-id';
import { CombinedViewsService } from '../application/combined-views.service';

export class OrganisationsOverviewQueryDto {
  @ApiPropertyOptional({ description: 'Only this organisation (on "All organisations")' })
  @IsOptional()
  @IsId()
  companyId?: string;
}

/** 3.3 GET /overview/organisations: the Super Manager's home, over 4.0's organisations. */
@ApiTags('overview')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('overview')
export class OrganisationsOverviewController {
  constructor(private readonly combined: CombinedViewsService) {}

  @Get('organisations')
  @Roles(Role.SUPER_MANAGER, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      '3.3: totals in view and one card per organisation (started, away, focus so far, pending ' +
      'and overdue approvals), plus the first items waiting for a decision. "All organisations" ' +
      'unless X-Org-Id or companyId names one.',
  })
  async get(@CurrentUser() me: AuthenticatedUser, @Query() q: OrganisationsOverviewQueryDto) {
    return envelope(await this.combined.organisations(me, new Date(), q.companyId));
  }
}
