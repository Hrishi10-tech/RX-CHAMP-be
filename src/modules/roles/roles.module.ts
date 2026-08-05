import { Module } from '@nestjs/common';
import { ROLE_REPOSITORY } from './domain/repositories/role.repository';
import { PostgresRoleRepository } from './infrastructure/repositories/postgres-role.repository';
import { CreateRoleUseCase } from './application/use-cases/create-role.use-case';
import { RolesController } from './presentation/roles.controller';

@Module({
  controllers: [RolesController],
  providers: [{ provide: ROLE_REPOSITORY, useClass: PostgresRoleRepository }, CreateRoleUseCase],
})
export class RolesModule {}
