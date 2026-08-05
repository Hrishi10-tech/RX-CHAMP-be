import { Module } from '@nestjs/common';
import { UsersModule } from '@modules/users/users.module';
import { COMPANY_REPOSITORY } from './domain/repositories/company.repository';
import { PostgresCompanyRepository } from './infrastructure/repositories/postgres-company.repository';
import { AssignCompanyUseCase } from './application/use-cases/assign-company.use-case';
import { CreateCompanyUseCase } from './application/use-cases/create-company.use-case';
import { ListCompaniesUseCase } from './application/use-cases/list-companies.use-case';
import { ListManagerUsersUseCase } from './application/use-cases/list-manager-users.use-case';
import { CompaniesController } from './presentation/companies.controller';

@Module({
  imports: [UsersModule],
  controllers: [CompaniesController],
  providers: [
    { provide: COMPANY_REPOSITORY, useClass: PostgresCompanyRepository },
    AssignCompanyUseCase,
    CreateCompanyUseCase,
    ListCompaniesUseCase,
    ListManagerUsersUseCase,
  ],
})
export class CompaniesModule {}
