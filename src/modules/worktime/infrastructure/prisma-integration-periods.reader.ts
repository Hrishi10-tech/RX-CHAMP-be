import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { isUuid } from '@modules/shifts/infrastructure/prisma-shift.repository';
import {
  BiometricStretchLite,
  IntegrationPeriodLite,
  IntegrationPeriodsReader,
} from '../domain/integration-periods.reader';

@Injectable()
export class PrismaIntegrationPeriodsReader implements IntegrationPeriodsReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(companyIds: string[]): Promise<Map<string, IntegrationPeriodLite[]>> {
    const out = new Map<string, IntegrationPeriodLite[]>();
    const ids = [...new Set(companyIds)].filter(isUuid);
    if (!ids.length) return out;
    const rows = await this.prisma.biometricIntegrationPeriod.findMany({
      where: { companyId: { in: ids } },
      orderBy: { fromDate: 'asc' },
      select: { companyId: true, fromDate: true, toDate: true },
    });
    for (const { companyId, fromDate, toDate } of rows) {
      out.set(companyId, [...(out.get(companyId) ?? []), { fromDate, toDate }]);
    }
    return out;
  }

  async biometricStretches(userIds: string[]): Promise<Map<string, BiometricStretchLite[]>> {
    const out = new Map<string, BiometricStretchLite[]>();
    if (!userIds.length) return out;
    const rows = await this.prisma.biometricSourcePeriod.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, fromDate: true, toDate: true },
    });
    for (const { userId, fromDate, toDate } of rows) {
      out.set(userId, [...(out.get(userId) ?? []), { fromDate, toDate }]);
    }
    return out;
  }
}
