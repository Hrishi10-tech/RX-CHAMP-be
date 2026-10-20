import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { SettingsStore } from '../domain/settings.store';

@Injectable()
export class PrismaSettingsStore implements SettingsStore {
  constructor(private readonly prisma: PrismaService) {}

  async read(key: string): Promise<unknown | null> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    return row ? (row.value as unknown) : null;
  }

  async write(key: string, value: unknown, updatedById: string | null): Promise<void> {
    const json = value as Prisma.InputJsonValue;
    await this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value: json, updatedById },
      update: { value: json, updatedById },
    });
  }

  async companyOfUser(userId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true },
    });
    return row?.companyId ?? null;
  }

  async idleFactsOfUser(userId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { companyId: true, departmentId: true, idleEnabled: true, idleMinutes: true },
    });
  }
}
