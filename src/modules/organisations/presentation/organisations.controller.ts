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
import { OrganisationsService } from '../application/organisations.service';
import { CreateOrgAdminDto, OrganisationNameDto } from '../application/dto/organisation.dto';

/** Organisations on the platform (docs/4.0/SPEC.md 5.1). Super Admin only. */
@ApiTags('organisations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('organisations')
export class OrganisationsController {
  constructor(private readonly organisations: OrganisationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Every organisation with its Admin, head counts and today (Super Admin)',
  })
  async list(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.organisations.list(me));
  }

  @Get('unassigned-people')
  @ApiOperation({ summary: 'People who belong to no organisation ("Needs an organisation")' })
  async unassigned(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.organisations.listUnassigned(me));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One organisation, as in the list' })
  async get(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.organisations.get(me, id));
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an organisation (name 2..80, unique ignoring case)' })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: OrganisationNameDto) {
    return envelope(await this.organisations.create(me, body.name));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename an organisation' })
  async rename(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: OrganisationNameDto,
  ) {
    return envelope(await this.organisations.rename(me, id, body.name));
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an organisation; 409 ORG_NOT_EMPTY while it has active people' })
  async remove(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.organisations.remove(me, id));
  }

  @Post(':id/admin')
  @HttpCode(201)
  @ApiOperation({ summary: "Create the organisation's Admin; 409 ADMIN_EXISTS when it has one" })
  async createAdmin(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: CreateOrgAdminDto,
  ) {
    return envelope(await this.organisations.createAdmin(me, id, body));
  }

  @Post(':id/people/:userId')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Put a person with no organisation into this one (moving between organisations is refused)',
  })
  async assignPerson(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Param('userId', new ParseIdPipe()) userId: string,
  ) {
    return envelope(await this.organisations.assignPerson(me, id, userId));
  }
}

/** GET /overview/platform: the Super Admin's platform view. */
@ApiTags('organisations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('overview')
export class PlatformOverviewController {
  constructor(private readonly organisations: OrganisationsService) {}

  @Get('platform')
  @ApiOperation({
    summary: 'Organisations with their today summary, and people needing an organisation',
  })
  async platform(@CurrentUser() me: AuthenticatedUser) {
    return envelope(await this.organisations.platformOverview(me));
  }
}
