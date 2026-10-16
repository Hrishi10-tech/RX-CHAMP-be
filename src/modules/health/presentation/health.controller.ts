import { Controller, Get, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@shared/database/prisma.service';
import { HealthStatus, ProcessMetrics } from '../application/health.types';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  @ApiOperation({
    summary: 'Health check: 200 when the API and database are up, 503 when the database is down',
  })
  async health(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      // A load balancer or uptime check keyed on the status code must see this
      // instance as unhealthy; a 200 with db:'down' kept traffic flowing to it.
      throw new ServiceUnavailableException({
        status: 'up',
        db: 'down',
        uptimeSec: Math.floor(process.uptime()),
      });
    }
    return { status: 'up', db: 'up', uptimeSec: Math.floor(process.uptime()) };
  }

  @Get('metrics')
  @ApiOperation({
    summary: 'Basic process metrics (off in production unless METRICS_ENABLED=true)',
  })
  metrics(): ProcessMetrics {
    if (process.env.NODE_ENV === 'production' && process.env.METRICS_ENABLED !== 'true') {
      throw new NotFoundException();
    }
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
