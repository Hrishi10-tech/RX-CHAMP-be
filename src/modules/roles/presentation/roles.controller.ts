
import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateRoleDto } from '../application/dto';
import { CreateRoleUseCase } from '../application/use-cases/create-role.use-case';

@ApiTags('roles')
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
