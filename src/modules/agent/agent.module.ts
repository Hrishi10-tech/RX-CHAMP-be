import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UsersModule } from '@modules/users/users.module';
import { AgentController } from './presentation/agent.controller';
import {
  AGENT_BINARY_STORE,
  AGENT_BINARY_STORES,
  AgentBinaryStore,
  AgentBinaryStores,
} from './domain/agent-binary.store';
import { LocalAgentBinaryStore } from './infrastructure/local-agent-binary.store';
import { S3AgentBinaryStore } from './infrastructure/s3-agent-binary.store';

/** S3 when a key is configured (containers have no build folder), else local disk. */
function storeFor(
  config: ConfigService,
  s3Key: string | undefined,
  path: string,
): AgentBinaryStore {
  return s3Key ? new S3AgentBinaryStore(config, s3Key) : new LocalAgentBinaryStore(path);
}

@Module({
  imports: [UsersModule], // for USER_REPOSITORY (manager-scope check)
  controllers: [AgentController],
  providers: [
    {
      provide: AGENT_BINARY_STORES,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AgentBinaryStores => ({
        windows: storeFor(
          config,
          config.get<string>('agent.s3Key'),
          config.get<string>('agent.binaryPath') ?? '',
        ),
        mac: storeFor(
          config,
          config.get<string>('agent.mac.s3Key'),
          config.get<string>('agent.mac.binaryPath') ?? '',
        ),
        'mac-x64': storeFor(
          config,
          config.get<string>('agent.macX64.s3Key'),
          config.get<string>('agent.macX64.binaryPath') ?? '',
        ),
      }),
    },
    {
      // Kept for anything still injecting the single (Windows) store.
      provide: AGENT_BINARY_STORE,
      inject: [AGENT_BINARY_STORES],
      useFactory: (stores: AgentBinaryStores) => stores.windows,
    },
  ],
})
export class AgentModule {}
