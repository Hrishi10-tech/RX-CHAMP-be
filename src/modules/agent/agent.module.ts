import { Module } from '@nestjs/common';
import { UsersModule } from '@modules/users/users.module';
import { AgentController } from './presentation/agent.controller';

@Module({
  imports: [UsersModule], // for USER_REPOSITORY (manager-scope check)
  controllers: [AgentController],
})
export class AgentModule {}
