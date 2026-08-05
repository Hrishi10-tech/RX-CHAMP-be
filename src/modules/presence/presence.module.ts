import { Module } from '@nestjs/common';
import { PRESENCE_SESSION_REPOSITORY } from './domain/presence-session.repository';
import { PRESENCE_TEAM_READER } from './domain/presence-team-reader.port';
import { ONLINE_SESSION_REPOSITORY } from './domain/online-session.repository';
import { IDLE_READER } from './domain/idle-reader.port';
import { PrismaPresenceSessionRepository } from './infrastructure/prisma-presence-session.repository';
import { PrismaPresenceTeamReader } from './infrastructure/prisma-presence-team-reader';
import { PrismaOnlineSessionRepository } from './infrastructure/prisma-online-session.repository';
import { PrismaIdleReader } from './infrastructure/prisma-idle-reader';
import { StartPresenceUseCase } from './application/use-cases/start-presence.use-case';
import { EndPresenceUseCase } from './application/use-cases/end-presence.use-case';
import { HeartbeatUseCase } from './application/use-cases/heartbeat.use-case';
import { GetCurrentPresenceUseCase } from './application/use-cases/get-current-presence.use-case';
import { GetMyTodayUseCase } from './application/use-cases/get-my-today.use-case';
import { GetTeamLiveUseCase } from './application/use-cases/get-team-live.use-case';
import { GetTeamSummaryUseCase } from './application/use-cases/get-team-summary.use-case';
import { GetUserHistoryUseCase } from './application/use-cases/get-user-history.use-case';
import { GetUserTimelineUseCase } from './application/use-cases/get-user-timeline.use-case';
import { GetProductivityUseCase } from './application/use-cases/get-productivity.use-case';
import { PresenceController } from './presentation/presence.controller';
import { ProductivityController } from './presentation/productivity.controller';
import { PresenceGateway } from './presentation/presence.gateway';

@Module({
  controllers: [PresenceController, ProductivityController],
  providers: [
    { provide: PRESENCE_SESSION_REPOSITORY, useClass: PrismaPresenceSessionRepository },
    { provide: PRESENCE_TEAM_READER, useClass: PrismaPresenceTeamReader },
    { provide: ONLINE_SESSION_REPOSITORY, useClass: PrismaOnlineSessionRepository },
    { provide: IDLE_READER, useClass: PrismaIdleReader },
    PresenceGateway,
    StartPresenceUseCase,
    EndPresenceUseCase,
    HeartbeatUseCase,
    GetCurrentPresenceUseCase,
    GetMyTodayUseCase,
    GetTeamLiveUseCase,
    GetTeamSummaryUseCase,
    GetUserHistoryUseCase,
    GetUserTimelineUseCase,
    GetProductivityUseCase,
  ],
})
export class PresenceModule {}
