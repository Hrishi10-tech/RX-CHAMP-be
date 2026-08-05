import { Injectable } from '@nestjs/common';
import { Notification as PrismaNotification, Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  CreateNotificationData,
  ListNotificationsFilter,
  NotificationRecord,
  NotificationRepository,
} from '../domain/notification.repository';

@Injectable()
export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}
  private where(userId: string, filter: ListNotificationsFilter = {}): Prisma.NotificationWhereInput {
    const where: Prisma.NotificationWhereInput = { userId };
    if (filter.unreadOnly) where.readAt = null;
    return where;
  }
  async create(data: CreateNotificationData): Promise<NotificationRecord> {
    const row = await this.prisma.notification.create({
      data: {
        userId: data.userId,
        type: data.type,
        title: data.title,
        body: data.body ?? null,
      },
    });
    return this.toRecord(row);
  }
  async listForUser(
    userId: string,
    filter: ListNotificationsFilter = {},
  ): Promise<NotificationRecord[]> {
    const rows = await this.prisma.notification.findMany({
      where: this.where(userId, filter),
      orderBy: { createdAt: 'desc' },
      skip: filter.skip,
      take: filter.take,
    });
    return rows.map((r) => this.toRecord(r));
  }
  async countForUser(userId: string, filter: ListNotificationsFilter = {}): Promise<number> {
    return this.prisma.notification.count({ where: this.where(userId, filter) });
  }
  async markRead(userId: string, id: string): Promise<NotificationRecord | null> {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId, readAt: null },
      data: { readAt: new Date() },
    });
    if (result.count === 0) {
      const existing = await this.prisma.notification.findFirst({ where: { id, userId } });
      return existing ? this.toRecord(existing) : null;
    }
    const row = await this.prisma.notification.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  private toRecord(row: PrismaNotification): NotificationRecord {
    return {
      id: row.id,
      userId: row.userId,
      type: row.type,
      title: row.title,
      body: row.body,
      readAt: row.readAt,
      createdAt: row.createdAt,
    };
  }
}
