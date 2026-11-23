import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { PushDeviceRow, PushRepository, PushSettlement } from '../domain/push.repository';
import { PushMessage, PushPlatform } from '../domain/push.types';

/** One person's phones and tablets. One push goes to all of them at once, so this bounds it. */
const MAX_DEVICES = 10;

@Injectable()
export class PrismaPushRepository implements PushRepository {
  constructor(private readonly prisma: PrismaService) {}

  async saveDevice(userId: string, token: string, platform: PushPlatform): Promise<void> {
    await this.prisma.pushDevice.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    const beyond = await this.prisma.pushDevice.findMany({
      where: { userId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: MAX_DEVICES,
      select: { id: true },
    });
    if (beyond.length) {
      await this.prisma.pushDevice.deleteMany({ where: { id: { in: beyond.map((d) => d.id) } } });
    }
  }

  async removeDevices(userId: string, token?: string): Promise<number> {
    const { count } = await this.prisma.pushDevice.deleteMany({
      where: { userId, ...(token !== undefined ? { token } : {}) },
    });
    return count;
  }

  async removeToken(token: string): Promise<void> {
    await this.prisma.pushDevice.deleteMany({ where: { token } });
  }

  devicesOf(userId: string): Promise<PushDeviceRow[]> {
    return this.prisma.pushDevice.findMany({
      where: { userId },
      select: { token: true, platform: true },
    });
  }

  record(message: PushMessage): Promise<{ id: string }> {
    return this.prisma.pushOutbox.create({
      data: {
        recipientId: message.recipientId,
        title: message.title,
        body: message.body,
        data: message.data ?? {},
      },
      select: { id: true },
    });
  }

  async settle(id: string, result: PushSettlement): Promise<void> {
    await this.prisma.pushOutbox.update({ where: { id }, data: result });
  }
}
