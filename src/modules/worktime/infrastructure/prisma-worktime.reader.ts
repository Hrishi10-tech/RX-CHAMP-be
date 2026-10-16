import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { LOCK_SCREEN_APP, MAX_GAP_SEC } from '@modules/activity/application/activity.constants';
import { isUuid } from '@modules/shifts/infrastructure/prisma-shift.repository';
import {
  HourBucketRow,
  PeopleFilter,
  PersonRow,
  PresenceRow,
  SessionDayRow,
  WorktimeReader,
} from '../domain/worktime.reader';

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  department: true,
  designation: true,
  companyId: true,
  managerId: true,
  status: true,
  deletedAt: true,
  createdAt: true,
  role: { select: { name: true } },
  manager: { select: { firstName: true, lastName: true } },
} as const;

type PersonPayload = Prisma.UserGetPayload<{ select: typeof PERSON_SELECT }>;

function personFromPrisma(r: PersonPayload): PersonRow {
  return {
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    role: r.role.name,
    department: r.department,
    designation: r.designation,
    companyId: r.companyId,
    managerId: r.managerId,
    managerName: r.manager ? `${r.manager.firstName} ${r.manager.lastName}`.trim() : null,
    active: r.status === 'ACTIVE' && r.deletedAt === null,
    joinedOn: dateKeyInZone(r.createdAt, appTimezone()),
  };
}

@Injectable()
export class PrismaWorktimeReader implements WorktimeReader {
  constructor(private readonly prisma: PrismaService) {}

  async presenceOverlapping(userIds: string[], from: Date, to: Date): Promise<PresenceRow[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.presenceSession.findMany({
      where: {
        userId: { in: userIds },
        startedAt: { lte: to },
        OR: [{ endedAt: null }, { endedAt: { gte: from } }],
      },
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
      select: {
        id: true,
        userId: true,
        type: true,
        note: true,
        date: true,
        startedAt: true,
        endedAt: true,
      },
    });
    return rows;
  }

  async sessionDays(
    userIds: string[],
    fromDate: string,
    toDate: string,
    settledBefore: Date,
  ): Promise<SessionDayRow[]> {
    if (!userIds.length) return [];
    const rows = await this.prisma.$queryRaw<{ user_id: string; date: string; settled: boolean }[]>`
      SELECT user_id::text AS user_id,
             date,
             (bool_and(ended_at IS NOT NULL)
              AND max(ended_at) < (${settledBefore.toISOString()}::timestamptz AT TIME ZONE 'UTC')) AS settled
        FROM work_sessions
       WHERE user_id = ANY(${userIds}::uuid[])
         AND date >= ${fromDate}
         AND date <= ${toDate}
       GROUP BY 1, 2`;
    return rows.map((r) => ({ userId: r.user_id, date: r.date, settled: r.settled === true }));
  }

  async activeSecByHour(
    days: { userId: string; date: string }[],
    tz: string,
  ): Promise<HourBucketRow[]> {
    if (!days.length) return [];
    // Active seconds = stamped durations of non-idle, unlocked samples (each capped
    // like the daily rollup) taken inside a work session of the day, filed under
    // that session's working day and bucketed by the local hour the sample started
    // in (so a night shift's hours after midnight stay on its day). Timestamps are
    // timestamp(3) holding UTC. JIT compiles this query for longer than it runs.
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRaw`SET LOCAL jit = off`,
      this.prisma.$queryRaw<{ user_id: string; date: string; hour: number; active_sec: number }[]>`
        SELECT ws.user_id::text AS user_id,
               ws.date,
               EXTRACT(HOUR FROM ((s.at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}))::int AS hour,
               SUM(LEAST(GREATEST(s.duration_sec, 0), ${MAX_GAP_SEC}))::int AS active_sec
          FROM unnest(${days.map((d) => d.userId)}::uuid[], ${days.map((d) => d.date)}::text[])
               AS d(user_id, date)
          JOIN work_sessions ws
            ON ws.user_id = d.user_id
           AND ws.date = d.date
          JOIN activity_samples s
            ON s.user_id = ws.user_id
           AND s.at >= ws.started_at
           AND s.at < COALESCE(ws.ended_at, 'infinity'::timestamp)
         WHERE s.idle = false
           AND s.locked = false
           AND (s.app IS NULL OR s.app <> ${LOCK_SCREEN_APP})
         GROUP BY 1, 2, 3`,
    ]);
    return rows.map((r) => ({
      userId: r.user_id,
      date: r.date,
      hour: r.hour,
      activeSec: Number(r.active_sec),
    }));
  }

  async listPeople(filter: PeopleFilter): Promise<PersonRow[]> {
    const where: Prisma.UserWhereInput = {};
    if (filter.managerId) where.managerId = filter.managerId;
    if (filter.ids) where.id = { in: filter.ids.filter(isUuid) };
    const rows = await this.prisma.user.findMany({
      where,
      select: PERSON_SELECT,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
    });
    return rows.map(personFromPrisma);
  }

  async userIdsWithSessionsBetween(
    userIds: string[] | null,
    fromDate: string,
    toDate: string,
  ): Promise<Set<string>> {
    if (userIds && !userIds.length) return new Set();
    const rows = await this.prisma.workSession.findMany({
      where: {
        date: { gte: fromDate, lte: toDate },
        ...(userIds ? { userId: { in: userIds } } : {}),
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return new Set(rows.map((r) => r.userId));
  }

  async searchParticipants(companyId: string | null, q: string, excludeId: string, limit: number) {
    const words = q.split(/\s+/).filter(Boolean).slice(0, 4);
    return this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        companyId,
        id: { not: excludeId },
        AND: words.map((w) => ({
          OR: [
            { firstName: { contains: w, mode: 'insensitive' as const } },
            { lastName: { contains: w, mode: 'insensitive' as const } },
          ],
        })),
      },
      select: { id: true, firstName: true, lastName: true, department: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  async knownPeopleIds(companyId: string | null, ids: string[]): Promise<Set<string>> {
    const wanted = [...new Set(ids)].filter(isUuid);
    if (!wanted.length) return new Set();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: wanted }, companyId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  async earliestSessionDate(): Promise<string | null> {
    const row = await this.prisma.workSession.findFirst({
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    return row?.date ?? null;
  }
}
