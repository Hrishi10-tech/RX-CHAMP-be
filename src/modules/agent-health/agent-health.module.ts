import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ShiftsModule } from '@modules/shifts/shifts.module';
import { WorktimeModule } from '@modules/worktime/worktime.module';
import { AgentContactService } from './application/agent-contact.service';
import { AgentHealthService } from './application/agent-health.service';
import { AGENT_CONTACT_REPOSITORY } from './domain/agent-contact.repository';
import { AGENT_HEALTH_READER } from './domain/agent-health.reader';
import { PrismaAgentContactRepository } from './infrastructure/prisma-agent-contact.repository';
import { PrismaAgentHealthReader } from './infrastructure/prisma-agent-health.reader';
import { AgentContactInterceptor } from './presentation/agent-contact.interceptor';
import { AgentHealthController } from './presentation/agent-health.controller';

/**
 * Agent health (3.3): whether each person's desktop agent reaches the server,
 * whether their day is running and whether screenshots arrive. The interceptor
 * notes every agent request; the screenshots module reports refused uploads
 * through AgentContactService. The interceptor is global (APP_INTERCEPTOR) and
 * only writes for agent requests, at most once a minute per person.
 */
@Module({
  imports: [WorktimeModule, ShiftsModule],
  controllers: [AgentHealthController],
  providers: [
    { provide: AGENT_CONTACT_REPOSITORY, useClass: PrismaAgentContactRepository },
    { provide: AGENT_HEALTH_READER, useClass: PrismaAgentHealthReader },
    AgentContactService,
    AgentHealthService,
    { provide: APP_INTERCEPTOR, useClass: AgentContactInterceptor },
  ],
  exports: [AgentContactService],
})
export class AgentHealthModule {}
