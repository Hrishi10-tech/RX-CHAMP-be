import { Injectable } from '@nestjs/common';
import { ChatMessage as PrismaChatMessage } from '@prisma/client';
import { AVATAR_COLUMNS, effectiveAvatarId } from '@shared/avatars/person-avatar';
import { PrismaService } from '@shared/database/prisma.service';
import {
  ChatMessageRecord,
  ChatRepository,
  CreateMessageData,
  ThreadSummary,
} from '../domain/chat.repository';

@Injectable()
export class PrismaChatRepository implements ChatRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateMessageData): Promise<ChatMessageRecord> {
    const row = await this.prisma.chatMessage.create({
      data: { fromUserId: data.fromUserId, toUserId: data.toUserId, body: data.body },
    });
    return this.toRecord(row, await this.avatarsOf([data.fromUserId]));
  }

  async listConversation(userA: string, userB: string, take: number): Promise<ChatMessageRecord[]> {
    const rows = await this.prisma.chatMessage.findMany({
      where: {
        OR: [
          { fromUserId: userA, toUserId: userB },
          { fromUserId: userB, toUserId: userA },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take,
    });
    const avatars = await this.avatarsOf([userA, userB]);
    return rows.reverse().map((r) => this.toRecord(r, avatars));
  }

  async markRead(userId: string, fromUserId: string): Promise<number> {
    const result = await this.prisma.chatMessage.updateMany({
      where: { toUserId: userId, fromUserId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  async countUnread(userId: string): Promise<number> {
    return this.prisma.chatMessage.count({ where: { toUserId: userId, readAt: null } });
  }

  async threadSummaries(meId: string, otherIds: string[]): Promise<ThreadSummary[]> {
    if (otherIds.length === 0) return [];

    const unreadRows = await this.prisma.chatMessage.groupBy({
      by: ['fromUserId'],
      where: { toUserId: meId, fromUserId: { in: otherIds }, readAt: null },
      _count: { _all: true },
    });
    const unreadByFrom = new Map(unreadRows.map((r) => [r.fromUserId, r._count._all]));

    const lasts = await Promise.all(
      otherIds.map((otherId) =>
        this.prisma.chatMessage.findFirst({
          where: {
            OR: [
              { fromUserId: meId, toUserId: otherId },
              { fromUserId: otherId, toUserId: meId },
            ],
          },
          orderBy: { createdAt: 'desc' },
        }),
      ),
    );

    const avatars = await this.avatarsOf([meId, ...otherIds]);
    return otherIds.map((otherId, i) => ({
      otherId,
      lastMessage: lasts[i] ? this.toRecord(lasts[i]!, avatars) : null,
      unreadCount: unreadByFrom.get(otherId) ?? 0,
    }));
  }

  private async avatarsOf(userIds: string[]): Promise<Map<string, string | null>> {
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, ...AVATAR_COLUMNS },
    });
    return new Map(rows.map((r) => [r.id, effectiveAvatarId(r)]));
  }

  private toRecord(row: PrismaChatMessage, avatars: Map<string, string | null>): ChatMessageRecord {
    return {
      id: row.id,
      fromUserId: row.fromUserId,
      toUserId: row.toUserId,
      body: row.body,
      readAt: row.readAt,
      createdAt: row.createdAt,
      fromAvatarId: avatars.get(row.fromUserId) ?? null,
    };
  }
}
