import { Module } from '@nestjs/common';
import { USER_REPOSITORY } from './domain/repositories/user.repository';
import { SHIFT_READER } from './domain/repositories/shift-reader.port';
import { ROLE_READER } from './domain/repositories/role-reader.port';
import { PostgresUserRepository } from './infrastructure/repositories/postgres-user.repository';
import { PrismaShiftReader } from './infrastructure/repositories/prisma-shift-reader';
import { PrismaRoleReader } from './infrastructure/repositories/prisma-role-reader';
import { CreateUsersUseCase } from './application/use-cases/create-users.use-case';
import { DeleteUserUseCase } from './application/use-cases/delete-user.use-case';
import { GetProfileUseCase } from './application/use-cases/get-profile.use-case';
import { ListUsersUseCase } from './application/use-cases/list-users.use-case';
import { SetUserScreenshotsUseCase } from './application/use-cases/set-user-screenshots.use-case';
import { SetUserStatusUseCase } from './application/use-cases/set-user-status.use-case';
import { UpdateUserUseCase } from './application/use-cases/update-user.use-case';
import { UsersController } from './presentation/users.controller';

@Module({
  controllers: [UsersController],
  providers: [
    { provide: USER_REPOSITORY, useClass: PostgresUserRepository },
    { provide: SHIFT_READER, useClass: PrismaShiftReader },
    { provide: ROLE_READER, useClass: PrismaRoleReader },
    CreateUsersUseCase,
    DeleteUserUseCase,
    GetProfileUseCase,
    ListUsersUseCase,
    SetUserStatusUseCase,
    SetUserScreenshotsUseCase,
    UpdateUserUseCase,
  ],
  exports: [USER_REPOSITORY, GetProfileUseCase],
})
export class UsersModule {}
