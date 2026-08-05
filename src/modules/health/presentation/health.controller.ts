import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@shared/database/prisma.service';
import { HealthStatus, ProcessMetrics } from '../application/health.types';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  @ApiOperation({ summary: 'Liveness check' })
  async health(): Promise<HealthStatus> {
    let db: HealthStatus['db'] = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    return { status: 'up', db, uptimeSec: Math.floor(process.uptime()) };
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Basic process metrics' })
  metrics(): ProcessMetrics {
    const mem = process.memoryUsage();
    return {
      uptimeSec: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
      pid: process.pid,
      nodeVersion: process.version,
    };
  }
}
