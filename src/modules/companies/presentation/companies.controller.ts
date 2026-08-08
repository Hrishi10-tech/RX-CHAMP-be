import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '@shared/rbac/jwt-auth.guard';
import { RolesGuard } from '@shared/rbac/roles.guard';
import { Roles } from '@shared/rbac/roles.decorator';
import { Role } from '@shared/rbac/roles.enum';
import { CurrentUser } from '@shared/rbac/current-user.decorator';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { envelope } from '@shared/http/envelope';
import {
  CreateCompanyDto,
  ListCompaniesQueryDto,
  ListManagerUsersQueryDto,
} from '../application/dto';
import { AssignCompanyUseCase } from '../application/use-cases/assign-company.use-case';
import { CreateCompanyUseCase } from '../application/use-cases/create-company.use-case';
import { ListCompaniesUseCase } from '../application/use-cases/list-companies.use-case';
import { ListManagerUsersUseCase } from '../application/use-cases/list-manager-users.use-case';

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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'List companies with manager/user counts (paginated)' })
  async list(@Query() query: ListCompaniesQueryDto) {
    const { companies, total, page, limit } = await this.listCompanies.execute(query);
    const totalPages = Math.ceil(total / limit);
    return envelope(companies, { meta: { total, page, limit, totalPages } });
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
  @Roles(Role.SUPER_ADMIN, Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: "List a manager's users within a company (paginated)" })
  async managerUsers(
    @Param('companyId') companyId: string,
    @Param('managerId') managerId: string,
    @Query() query: ListManagerUsersQueryDto,
  ) {
    const { users, total, page, limit } = await this.listManagerUsers.execute(
      companyId,
      managerId,
      query,
    );
    const totalPages = Math.ceil(total / limit);
    return envelope(users, { meta: { total, page, limit, totalPages } });
  }
}
