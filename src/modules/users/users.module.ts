import { Module } from '@nestjs/common';
import { USER_REPOSITORY } from './domain/repositories/user.repository';
import { SHIFT_READER } from './domain/repositories/shift-reader.port';
import { ROLE_READER } from './domain/repositories/role-reader.port';
import { DEPARTMENT_READER } from './domain/repositories/department-reader.port';
import { AGENT_PRESENCE_READER } from './domain/repositories/agent-presence.reader';
import { PrismaAgentPresenceReader } from './infrastructure/repositories/prisma-agent-presence.reader';
import { PostgresUserRepository } from './infrastructure/repositories/postgres-user.repository';
import { PrismaShiftReader } from './infrastructure/repositories/prisma-shift-reader';
import { PrismaRoleReader } from './infrastructure/repositories/prisma-role-reader';
import { PrismaDepartmentReader } from './infrastructure/repositories/prisma-department-reader';
import { CreateUsersUseCase } from './application/use-cases/create-users.use-case';
import { DeleteUserUseCase } from './application/use-cases/delete-user.use-case';
import { GetMeUseCase } from './application/use-cases/get-me.use-case';
import { GetProfileUseCase } from './application/use-cases/get-profile.use-case';
import { ListUsersUseCase } from './application/use-cases/list-users.use-case';
import { SetUserGrantsUseCase } from './application/use-cases/set-user-grants.use-case';
import { SetUserIdleUseCase } from './application/use-cases/set-user-idle.use-case';
import { SetUserScreenshotsUseCase } from './application/use-cases/set-user-screenshots.use-case';
import { SetUserStatusUseCase } from './application/use-cases/set-user-status.use-case';
import { UpdateUserUseCase } from './application/use-cases/update-user.use-case';
import { SetUserPasswordUseCase } from './application/use-cases/set-user-password.use-case';
import { MeController, UsersController } from './presentation/users.controller';

@Module({
  controllers: [UsersController, MeController],
  providers: [
    { provide: USER_REPOSITORY, useClass: PostgresUserRepository },
    { provide: SHIFT_READER, useClass: PrismaShiftReader },
    { provide: ROLE_READER, useClass: PrismaRoleReader },
    { provide: DEPARTMENT_READER, useClass: PrismaDepartmentReader },
    { provide: AGENT_PRESENCE_READER, useClass: PrismaAgentPresenceReader },
    CreateUsersUseCase,
    DeleteUserUseCase,
    GetMeUseCase,
    GetProfileUseCase,
    ListUsersUseCase,
    SetUserGrantsUseCase,
    SetUserIdleUseCase,
    SetUserStatusUseCase,
    SetUserScreenshotsUseCase,
    UpdateUserUseCase,
    SetUserPasswordUseCase,
  ],
  exports: [USER_REPOSITORY, GetProfileUseCase],
})
export class UsersModule {}
