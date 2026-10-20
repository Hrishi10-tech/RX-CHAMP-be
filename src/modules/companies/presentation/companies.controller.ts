import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { GoneError } from '@shared/exceptions/app.exception';
import { orgOf, requireOrg } from '@shared/tenancy';
import { ParseIdPipe } from '@shared/validation/is-id';
import { CreateCompanyDto, ListCompaniesQueryDto, UpdateCompanyDto } from '../application/dto';
import { AssignCompanyUseCase } from '../application/use-cases/assign-company.use-case';
import { CreateCompanyUseCase } from '../application/use-cases/create-company.use-case';
import { DeleteCompanyUseCase } from '../application/use-cases/delete-company.use-case';
import { ListCompaniesUseCase } from '../application/use-cases/list-companies.use-case';
import { UpdateCompanyUseCase } from '../application/use-cases/update-company.use-case';

/**
 * 3.x /companies, kept as an alias of /organisations for one release
 * (docs/4.0/SPEC.md 5.1) with the 4.0 tenancy rules: writes are Super Admin
 * only; the list shows a Super Admin every organisation (or the one chosen with
 * X-Org-Id) and an Admin or Manager their own.
 */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly createCompany: CreateCompanyUseCase,
    private readonly listCompanies: ListCompaniesUseCase,
    private readonly assignCompany: AssignCompanyUseCase,
    private readonly deleteCompany: DeleteCompanyUseCase,
    private readonly updateCompany: UpdateCompanyUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: '(3.x alias of POST /organisations) Create an organisation (Super Admin)',
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateCompanyDto) {
    return this.createCompany.execute({ name: body.name, managerIds: body.managerIds }, me);
  }

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({
    summary: '(3.x alias) Organisations with manager and people counts (Admin, Manager: their own)',
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() query: ListCompaniesQueryDto) {
    const onlyIds =
      me.role === Role.SUPER_ADMIN ? (orgOf(me) ? [orgOf(me)!] : undefined) : [requireOrg(me)];
    const { companies, total, page, limit } = await this.listCompanies.execute(query, onlyIds);
    const totalPages = Math.ceil(total / limit);
    return envelope(companies, { meta: { total, page, limit, totalPages } });
  }

  @Patch(':id')
  @ApiOperation({ summary: '(3.x alias of PATCH /organisations/:id) Rename an organisation' })
  async update(
    @CurrentUser() me: AuthenticatedUser,
    @Param('id', new ParseIdPipe()) id: string,
    @Body() body: UpdateCompanyDto,
  ) {
    return envelope(await this.updateCompany.execute(me, id, { name: body.name }));
  }

  @Delete(':id')
  @ApiOperation({
    summary:
      '(3.x alias of DELETE /organisations/:id) Delete an organisation; 409 ORG_NOT_EMPTY while it has active people',
  })
  async remove(@CurrentUser() me: AuthenticatedUser, @Param('id', new ParseIdPipe()) id: string) {
    return envelope(await this.deleteCompany.execute(me, id));
  }

  @Post(':companyId/managers/:managerId')
  @HttpCode(200)
  @ApiOperation({
    summary:
      '(3.x alias) Put a person with no organisation into this one; 409 PERSON_IN_ORGANISATION when they have one',
  })
  async assign(
    @CurrentUser() me: AuthenticatedUser,
    @Param('companyId', new ParseIdPipe()) companyId: string,
    @Param('managerId', new ParseIdPipe()) managerId: string,
  ) {
    return envelope(await this.assignCompany.execute(me, companyId, managerId));
  }

  @Get(':companyId/managers/:managerId/users')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: '(removed in 4.0) answers 410 GONE' })
  managerUsers(): never {
    throw new GoneError(
      "Reporting lines were replaced by departments in 4.0. Use GET /users?departmentId=... for a department's staff.",
    );
  }
}
