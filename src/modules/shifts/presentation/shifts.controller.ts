import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
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
import {
  AssignDepartmentDto,
  AssignPeopleDto,
  ListPeopleShiftsQueryDto,
  UpsertShiftDto,
} from '../application/dto';
import { ManageShiftsUseCase } from '../application/use-cases/manage-shifts.use-case';
import { ShiftAssignmentsUseCase } from '../application/use-cases/shift-assignments.use-case';
import { ParseIdPipe } from '@shared/validation/is-id';

@ApiTags('shifts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.MANAGER)
@Controller('shifts')
export class ShiftsController {
  constructor(private readonly manage: ManageShiftsUseCase) {}

  @Get()
  @ApiOperation({ summary: 'Every shift with its breaks and who it applies to today' })
  async list(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.manage.list(me));
  }

  @Post('validate')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Check a shift definition without saving it (the editor shows the problems live)',
  })
  async validate(@Body() body: UpsertShiftDto) {
    return envelope(await this.manage.validate(body));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One shift' })
  async get(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.manage.get(me, id));
  }

  @Post()
  @HttpCode(201)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create a shift with its morning, lunch and evening breaks' })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: UpsertShiftDto) {
    return envelope(await this.manage.create(me, body));
  }

  @Put(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Replace a shift definition (applies from the next break that has not started)',
  })
  async update(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: UpsertShiftDto,
  ) {
    return envelope(await this.manage.update(me, id, body));
  }

  @Post(':id/default')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Make this the default shift for people with no department or personal shift',
  })
  async makeDefault(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
  ) {
    return envelope(await this.manage.makeDefault(me, id));
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete a shift that is no longer assigned' })
  async remove(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.manage.remove(me, id));
  }
}

@ApiTags('shifts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN, Role.MANAGER)
@Controller('shift-assignments')
export class ShiftAssignmentsController {
  constructor(private readonly assignments: ShiftAssignmentsUseCase) {}

  @Get('departments')
  @ApiOperation({ summary: "Each department's shift today and any change scheduled" })
  async departments(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.assignments.listDepartments(me));
  }

  @Put('departments')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: "Set a department's shift from a day onward (Super Admin)" })
  async assignDepartment(@CurrentUser() me: AuthenticatedUser, @Body() body: AssignDepartmentDto) {
    return envelope(await this.assignments.assignDepartment(me, body));
  }

  @Get('people')
  @ApiOperation({
    summary: 'People and the shift that applies to them today (a Manager sees their own staff)',
  })
  async people(@CurrentUser() me: AuthenticatedUser, @Query() query: ListPeopleShiftsQueryDto) {
    const { items, meta } = await this.assignments.listPeople(me, query);
    return envelope(items, { meta });
  }

  @Put('people')
  @ApiOperation({
    summary: "Override people's shift for a period, or send them back to their department's",
  })
  async assignPeople(@CurrentUser() me: AuthenticatedUser, @Body() body: AssignPeopleDto) {
    return envelope(await this.assignments.assignPeople(me, body));
  }
}
