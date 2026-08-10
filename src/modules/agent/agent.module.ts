import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersModule } from '@modules/users/users.module';
import { AgentController } from './presentation/agent.controller';
import { AGENT_BINARY_STORE } from './domain/agent-binary.store';
import { LocalAgentBinaryStore } from './infrastructure/local-agent-binary.store';
import { S3AgentBinaryStore } from './infrastructure/s3-agent-binary.store';

@Module({
  imports: [UsersModule], // for USER_REPOSITORY (manager-scope check)
  controllers: [AgentController],
  providers: [
    LocalAgentBinaryStore,
    S3AgentBinaryStore,
    {
      // Prefer S3 when AGENT_S3_KEY is set (the container has no installer folder),
      // otherwise read the binary from disk (developer machines).
      provide: AGENT_BINARY_STORE,
      inject: [ConfigService, LocalAgentBinaryStore, S3AgentBinaryStore],
      useFactory: (config: ConfigService, local: LocalAgentBinaryStore, s3: S3AgentBinaryStore) =>
        config.get<string>('agent.s3Key') ? s3 : local,
    },
  ],
})
export class AgentModule {}
