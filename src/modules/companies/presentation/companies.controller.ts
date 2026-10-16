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
import { NotFoundError } from '@shared/exceptions/app.exception';
import {
  CreateCompanyDto,
  ListCompaniesQueryDto,
  ListManagerUsersQueryDto,
  UpdateCompanyDto,
} from '../application/dto';
import { AssignCompanyUseCase } from '../application/use-cases/assign-company.use-case';
import { CreateCompanyUseCase } from '../application/use-cases/create-company.use-case';
import { DeleteCompanyUseCase } from '../application/use-cases/delete-company.use-case';
import { ListCompaniesUseCase } from '../application/use-cases/list-companies.use-case';
import { ListManagerUsersUseCase } from '../application/use-cases/list-manager-users.use-case';
import { UpdateCompanyUseCase } from '../application/use-cases/update-company.use-case';

@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SUPER_ADMIN)
@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly createCompany: CreateCompanyUseCase,
    private readonly listCompanies: ListCompaniesUseCase,
    private readonly listManagerUsers: ListManagerUsersUseCase,
    private readonly assignCompany: AssignCompanyUseCase,
    private readonly deleteCompany: DeleteCompanyUseCase,
    private readonly updateCompany: UpdateCompanyUseCase,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'Create a company (SUPER_ADMIN). Optionally assign managers in the same call.',
  })
  async create(@CurrentUser() me: AuthenticatedUser, @Body() body: CreateCompanyDto) {
    return this.createCompany.execute({ name: body.name, managerIds: body.managerIds }, me);
  }

  @Get()
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({
    summary: 'List companies with manager/user counts (Super Admin: all; Manager: their own)',
  })
  async list(@CurrentUser() me: AuthenticatedUser, @Query() query: ListCompaniesQueryDto) {
    const onlyIds = me.role === Role.SUPER_ADMIN ? undefined : me.companyId ? [me.companyId] : [];
    const { companies, total, page, limit } = await this.listCompanies.execute(query, onlyIds);
    const totalPages = Math.ceil(total / limit);
    return envelope(companies, { meta: { total, page, limit, totalPages } });
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Rename a company (SUPER_ADMIN)' })
  async update(@Param('id') id: string, @Body() body: UpdateCompanyDto) {
    const company = await this.updateCompany.execute(id, { name: body.name });
    return envelope(company);
  }

  @Delete(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'Delete a company (SUPER_ADMIN). Soft delete: the company and any members still ' +
      'attached go with it, and every record is kept.',
  })
  async remove(@Param('id') id: string) {
    const result = await this.deleteCompany.execute(id);
    return envelope(result);
  }

  @Post(':companyId/managers/:managerId')
  @HttpCode(200)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Assign a company to a user/manager (SUPER_ADMIN). Notifies the manager.',
  })
  async assign(
    @CurrentUser() me: AuthenticatedUser,
    @Param('companyId') companyId: string,
    @Param('managerId') managerId: string,
  ) {
    const user = await this.assignCompany.execute(me, companyId, managerId);
    return envelope(user);
  }

  @Get(':companyId/managers/:managerId/users')
  @Roles(Role.SUPER_ADMIN, Role.MANAGER)
  @ApiOperation({ summary: "List a manager's users within a company (paginated)" })
  async managerUsers(
    @CurrentUser() me: AuthenticatedUser,
    @Param('companyId') companyId: string,
    @Param('managerId') managerId: string,
    @Query() query: ListManagerUsersQueryDto,
  ) {
    // A Manager may look only at their own team, never another manager's.
    if (me.role !== Role.SUPER_ADMIN && managerId !== me.id) {
      throw new NotFoundError('Unknown manager');
    }
    const { users, total, page, limit } = await this.listManagerUsers.execute(
      companyId,
      managerId,
      query,
    );
    const totalPages = Math.ceil(total / limit);
    return envelope(users, { meta: { total, page, limit, totalPages } });
  }
}
