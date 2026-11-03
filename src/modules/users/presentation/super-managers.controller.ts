import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { CreateSuperManagerDto } from '../application/dto';
import { SuperManagersUseCase } from '../application/use-cases/super-managers.use-case';

/**
 * Super Manager accounts (3.3). Super Admin only, no organisation needed: the
 * account belongs to none. Edit, block, password and delete use /users/:id.
 */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('super-managers')
export class SuperManagersController {
  constructor(private readonly superManagers: SuperManagersUseCase) {}

  @Get()
  @ApiOperation({ summary: 'Every Super Manager account (Super Admin)' })
  async list(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.superManagers.list(me));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Add a Super Manager: no organisation, department or grants; 409 EMAIL_IN_USE (Super Admin)',
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateSuperManagerDto) {
    return envelope(await this.superManagers.create(me, body));
  }
}
