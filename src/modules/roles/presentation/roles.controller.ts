import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CreateRoleDto } from '../application/dto';
import { CreateRoleUseCase } from '../application/use-cases/create-role.use-case';

@ApiTags('roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('roles')
export class RolesController {
  constructor(private readonly createRole: CreateRoleUseCase) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a role + grant permissions (SUPER_ADMIN only)' })
  async create(@Body() body: CreateRoleDto) {
    return this.createRole.execute({
      name: body.name,
      permissionCodes: body.permissions ?? [],
    });
  }
}
