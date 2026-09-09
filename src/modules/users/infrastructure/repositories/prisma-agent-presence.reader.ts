import { Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { localDateString } from '@modules/activity/application/activity-date.util';
import {
  AgentPresence,
  AgentPresenceReader,
} from '../../domain/repositories/agent-presence.reader';

@Injectable()
export class PrismaAgentPresenceReader implements AgentPresenceReader {
  constructor(private readonly prisma: PrismaService) {}

  async presenceFor(userIds: string[]): Promise<Map<string, AgentPresence>> {
    if (userIds.length === 0) return new Map();

    const now = new Date();
    // Three grouped queries for the whole page, rather than three per row.
    const [samples, ended, sessions] = await Promise.all([
      this.prisma.activitySample.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds } },
        _max: { at: true },
      }),
      this.prisma.workDayEnd.findMany({
        where: { userId: { in: userIds }, date: localDateString(now), endedAt: { not: null } },
        select: { userId: true },
      }),
      // A session the agent could still use: not revoked, not expired. Signing out
      // revokes it, and a broken rotation leaves none either — same outcome.
      this.prisma.refreshToken.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, revokedAt: null, expiresAt: { gt: now } },
        _count: { _all: true },
      }),
    ]);

    const lastSeen = new Map(samples.filter((s) => s._max.at).map((s) => [s.userId, s._max.at!]));
    const endedToday = new Set(ended.map((e) => e.userId));
    const withSession = new Set(sessions.filter((s) => s._count._all > 0).map((s) => s.userId));

    const out = new Map<string, AgentPresence>();
    for (const id of userIds) {
      out.set(id, {
        lastSeenAt: lastSeen.get(id),
        dayEndedToday: endedToday.has(id),
        signedOut: !withSession.has(id),
      });
    }
    return out;
  }
}
