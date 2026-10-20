import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import { ParseIdPipe } from '@shared/validation/is-id';
import { DepartmentsService } from '../application/departments.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from '../application/dto/department.dto';
import { DEPARTMENT_ICONS } from '../domain/department.rules';

@ApiTags('departments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.ADMIN)
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary:
      'Departments of the organisation with staff count, managers and input tracking (Manager: their own)',
  })
  async list(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.departments.list(me));
  }

  @Get('icons')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'The icon keys a department can use (SPEC 7.6)' })
  icons() {
    return envelope([...DEPARTMENT_ICONS]);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a department (Admin, Super Admin); 409 DEPARTMENT_EXISTS' })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateDepartmentDto) {
    return envelope(await this.departments.create(me, body));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Rename a department or change its icon (people and shift assignments follow)',
  })
  async update(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: UpdateDepartmentDto,
  ) {
    return envelope(await this.departments.update(me, id, body));
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete an empty department (managers are unassigned); 409 DEPARTMENT_NOT_EMPTY',
  })
  async remove(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.departments.remove(me, id));
  }
}
