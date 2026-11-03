import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  AgentHealthPerson,
  AgentHealthReader,
  SampleStats,
  ScreenshotStats,
  SignInStats,
} from '../domain/agent-health.reader';

const AGENT_UA_PREFIX = 'RXVisionAgent/';

@Injectable()
export class PrismaAgentHealthReader implements AgentHealthReader {
  constructor(private readonly prisma: PrismaService) {}

  async people(where: Record<string, unknown>): Promise<AgentHealthPerson[]> {
    const rows = await this.prisma.user.findMany({
      where: where as Prisma.UserWhereInput,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        department: true,
        departmentId: true,
        companyId: true,
        role: { select: { name: true } },
        company: { select: { name: true } },
        departmentRef: { select: { name: true, deletedAt: true } },
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => ({
      id: r.id,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      role: r.role.name,
      // 4.0 departments are rows; the 3.x free-text field is the fallback.
      department:
        r.departmentRef && r.departmentRef.deletedAt === null ? r.departmentRef.name : r.department,
      departmentId: r.departmentId,
      companyId: r.companyId,
      companyName: r.company?.name ?? null,
    }));
  }

  async sampleStats(userIds: string[], date: string): Promise<Map<string, SampleStats>> {
    if (!userIds.length) return new Map();
    // The newest sample per person (its idle flag), the newest active one, and
    // today's count: one pass over (user_id, at), which is indexed.
    const rows = await this.prisma.$queryRaw<
      {
        user_id: string;
        last_at: Date | null;
        last_active_at: Date | null;
        today: bigint | number;
        last_idle: boolean | null;
      }[]
    >(Prisma.sql`
      WITH agg AS (
        SELECT user_id,
               max(at) AS last_at,
               max(at) FILTER (WHERE NOT idle AND NOT locked) AS last_active_at,
               count(*) FILTER (WHERE date = ${date}) AS today
          FROM activity_samples
         WHERE user_id IN (${Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`))})
         GROUP BY user_id
      )
      SELECT agg.*, (SELECT (s.idle OR s.locked) FROM activity_samples s
                      WHERE s.user_id = agg.user_id AND s.at = agg.last_at
                      ORDER BY s.at DESC LIMIT 1) AS last_idle
        FROM agg`);
    return new Map(
      rows.map((r) => [
        r.user_id,
        {
          lastAt: r.last_at,
          lastActiveAt: r.last_active_at,
          today: Number(r.today),
          lastIdle: r.last_idle ?? false,
        },
      ]),
    );
  }

  async screenshotStats(userIds: string[], dayStart: Date): Promise<Map<string, ScreenshotStats>> {
    if (!userIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<
      { user_id: string; last_at: Date | null; today: bigint | number }[]
    >(Prisma.sql`
      SELECT user_id,
             max(taken_at) AS last_at,
             count(*) FILTER (WHERE taken_at >= ${dayStart}) AS today
        FROM screenshots
       WHERE user_id IN (${Prisma.join(userIds.map((id) => Prisma.sql`${id}::uuid`))})
       GROUP BY user_id`);
    return new Map(rows.map((r) => [r.user_id, { lastAt: r.last_at, today: Number(r.today) }]));
  }

  async signIns(userIds: string[], now: Date): Promise<Map<string, SignInStats>> {
    if (!userIds.length) return new Map();
    const tokens = await this.prisma.refreshToken.findMany({
      where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: now } },
      select: { userId: true, userAgent: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const out = new Map<string, SignInStats>();
    for (const t of tokens) {
      const cur = out.get(t.userId) ?? { signedIn: false, agentUserAgent: null };
      cur.signedIn = true;
      if (!cur.agentUserAgent && t.userAgent?.startsWith(AGENT_UA_PREFIX)) {
        cur.agentUserAgent = t.userAgent;
      }
      out.set(t.userId, cur);
    }
    return out;
  }

  async screenshotsEnabled(userIds: string[]): Promise<Map<string, boolean>> {
    if (!userIds.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, screenshotsEnabled: true },
    });
    return new Map(rows.map((r) => [r.id, r.screenshotsEnabled]));
  }
}
