import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import {
  AgentContactRecord,
  AgentContactRepository,
  UploadRefusal,
} from '../domain/agent-contact.repository';

@Injectable()
export class PrismaAgentContactRepository implements AgentContactRepository {
  constructor(private readonly prisma: PrismaService) {}

  async touch(userId: string, userAgent: string | null, at: Date): Promise<void> {
    const ua = userAgent ? userAgent.slice(0, 300) : null;
    await this.prisma.agentContact.upsert({
      where: { userId },
      create: { userId, lastContactAt: at, userAgent: ua },
      update: { lastContactAt: at, userAgent: ua },
    });
  }

  async recordRefusal(userId: string, r: UploadRefusal): Promise<void> {
    const data = {
      lastRefusalAt: r.at,
      lastRefusalStatus: r.status,
      lastRefusalCode: r.code.slice(0, 40),
      lastRefusalReason: r.reason.slice(0, 300),
      lastRefusalBytes: r.bytes,
    };
    await this.prisma.agentContact.upsert({
      where: { userId },
      // A refusal is a contact too: the agent reached us.
      create: { userId, lastContactAt: r.at, ...data },
      update: { lastContactAt: r.at, ...data },
    });
  }

  async forUsers(userIds: string[]): Promise<Map<string, AgentContactRecord>> {
    if (!userIds.length) return new Map();
    const rows = await this.prisma.agentContact.findMany({ where: { userId: { in: userIds } } });
    return new Map(
      rows.map((r) => [
        r.userId,
        {
          userId: r.userId,
          lastContactAt: r.lastContactAt,
          userAgent: r.userAgent,
          lastRefusal:
            r.lastRefusalAt && r.lastRefusalStatus != null && r.lastRefusalCode
              ? {
                  at: r.lastRefusalAt,
                  status: r.lastRefusalStatus,
                  code: r.lastRefusalCode,
                  reason: r.lastRefusalReason ?? '',
                  bytes: r.lastRefusalBytes,
                }
              : null,
        },
      ]),
    );
  }
}
