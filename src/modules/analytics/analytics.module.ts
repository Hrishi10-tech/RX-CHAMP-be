import { Module } from '@nestjs/common';
import { ANALYTICS_READER } from './domain/analytics.reader';
import { PrismaAnalyticsReader } from './infrastructure/prisma-analytics.reader';
import { GetDashboardAnalyticsUseCase } from './application/use-cases/get-dashboard-analytics.use-case';
import { AnalyticsController } from './presentation/analytics.controller';

@Module({
  controllers: [AnalyticsController],
  providers: [
    { provide: ANALYTICS_READER, useClass: PrismaAnalyticsReader },
    GetDashboardAnalyticsUseCase,
  ],
})
export class AnalyticsModule {}
