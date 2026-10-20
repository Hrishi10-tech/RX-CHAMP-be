import { Module } from '@nestjs/common';
import { UsersModule } from '@modules/users/users.module';
import { OrganisationsModule } from '@modules/organisations/organisations.module';
import { COMPANY_REPOSITORY } from './domain/repositories/company.repository';
import { PostgresCompanyRepository } from './infrastructure/repositories/postgres-company.repository';
import { AssignCompanyUseCase } from './application/use-cases/assign-company.use-case';
import { CreateCompanyUseCase } from './application/use-cases/create-company.use-case';
import { DeleteCompanyUseCase } from './application/use-cases/delete-company.use-case';
import { ListCompaniesUseCase } from './application/use-cases/list-companies.use-case';
import { UpdateCompanyUseCase } from './application/use-cases/update-company.use-case';
import { CompaniesController } from './presentation/companies.controller';

/** 3.x /companies: an alias of /organisations for one release (docs/4.0/SPEC.md 5.1). */
@Module({
  imports: [UsersModule, OrganisationsModule],
  controllers: [CompaniesController],
  providers: [
    { provide: COMPANY_REPOSITORY, useClass: PostgresCompanyRepository },
    AssignCompanyUseCase,
    CreateCompanyUseCase,
    DeleteCompanyUseCase,
    ListCompaniesUseCase,
    UpdateCompanyUseCase,
  ],
})
export class CompaniesModule {}
