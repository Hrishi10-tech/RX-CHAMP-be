import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { LOCK_SCREEN_APP, MAX_GAP_SEC } from '@modules/activity/application/activity.constants';
import { isUuid } from '@modules/shifts/infrastructure/prisma-shift.repository';
import { COVERAGE_JOIN_SEC } from '../domain/focus';
import {
  CoverageRow,
  DepartmentRow,
  HourBucketRow,
  LiveFacts,
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
  departmentId: true,
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
    departmentId: r.departmentId,
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
    const rows = await this.prisma.$queryRaw<
      { user_id: string; date: string; settled: boolean; closed: boolean; stamp: string }[]
    >`
      SELECT user_id::text AS user_id,
             date,
             (bool_and(ended_at IS NOT NULL)
              AND max(ended_at) < (${settledBefore.toISOString()}::timestamptz AT TIME ZONE 'UTC')) AS settled,
             bool_and(ended_at IS NOT NULL) AS closed,
             count(*)::text || '|' || max(updated_at)::text AS stamp
        FROM work_sessions
       WHERE user_id = ANY(${userIds}::uuid[])
         AND date >= ${fromDate}
         AND date <= ${toDate}
       GROUP BY 1, 2`;
    return rows.map((r) => ({
      userId: r.user_id,
      date: r.date,
      settled: r.settled === true,
      closed: r.closed === true,
      stamp: r.stamp,
    }));
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

  async activityCoverage(sessionIds: string[]): Promise<CoverageRow[]> {
    const ids = [...new Set(sessionIds)].filter(isUuid);
    if (!ids.length) return [];
    // Each sample covers [at, at + its stamped duration capped like the daily
    // rollup] (idle and locked ones too: the agent was running); samples less than
    // COVERAGE_JOIN_SEC apart join into one stretch (gaps and islands), per session.
    // Timestamps are timestamp(3) holding UTC, as in activeSecByHour.
    const [, rows] = await this.prisma.$transaction([
      this.prisma.$executeRaw`SET LOCAL jit = off`,
      this.prisma.$queryRaw<
        { session_id: string; user_id: string; started_at: Date; ended_at: Date }[]
      >`
        WITH s AS (
          SELECT ws.id AS session_id,
                 ws.user_id,
                 a.at AS s,
                 a.at + LEAST(GREATEST(a.duration_sec, 0), ${MAX_GAP_SEC}) * interval '1 second' AS e
            FROM work_sessions ws
            JOIN activity_samples a
              ON a.user_id = ws.user_id
             AND a.at >= ws.started_at - ${MAX_GAP_SEC} * interval '1 second'
             AND a.at < COALESCE(ws.ended_at, 'infinity'::timestamp)
           WHERE ws.id = ANY(${ids}::uuid[])
        ),
        o AS (
          SELECT session_id, user_id, s, e,
                 CASE WHEN s <= max(e) OVER (
                        PARTITION BY session_id ORDER BY s, e
                        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                      ) + ${COVERAGE_JOIN_SEC} * interval '1 second'
                      THEN 0 ELSE 1 END AS brk
            FROM s
        ),
        g AS (
          SELECT session_id, user_id, s, e,
                 sum(brk) OVER (PARTITION BY session_id ORDER BY s, e ROWS UNBOUNDED PRECEDING) AS grp
            FROM o
        )
        SELECT session_id::text AS session_id, user_id::text AS user_id,
               min(s) AS started_at, max(e) AS ended_at
          FROM g
         GROUP BY session_id, user_id, grp
         ORDER BY 1, 3`,
    ]);
    return rows.map((r) => ({
      userId: r.user_id,
      sessionId: r.session_id,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  async listPeople(filter: PeopleFilter): Promise<PersonRow[]> {
    const where: Prisma.UserWhereInput = {};
    if (filter.managerId) where.managerId = filter.managerId;
    if (filter.ids) where.id = { in: filter.ids.filter(isUuid) };
    if (filter.companyId) where.companyId = filter.companyId;
    if (filter.departmentIds) where.departmentId = { in: filter.departmentIds.filter(isUuid) };
    if (filter.roles || filter.excludeRoles) {
      where.role = {
        name: {
          ...(filter.roles ? { in: filter.roles } : {}),
          ...(filter.excludeRoles ? { notIn: filter.excludeRoles } : {}),
        },
      };
    }
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

  async managedDepartments(managerIds: string[]): Promise<Map<string, string[]>> {
    const ids = [...new Set(managerIds)].filter(isUuid);
    const out = new Map<string, string[]>();
    if (!ids.length) return out;
    const rows = await this.prisma.managerDepartment.findMany({
      where: { managerId: { in: ids }, department: { deletedAt: null } },
      select: { managerId: true, departmentId: true },
    });
    for (const r of rows) out.set(r.managerId, [...(out.get(r.managerId) ?? []), r.departmentId]);
    return out;
  }

  async listCompanyIds(): Promise<string[]> {
    const rows = await this.prisma.company.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async departmentsOf(companyId: string): Promise<DepartmentRow[]> {
    if (!isUuid(companyId)) return [];
    return this.prisma.department.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true, icon: true },
      orderBy: { name: 'asc' },
    });
  }

  async liveFacts(userIds: string[]): Promise<Map<string, LiveFacts>> {
    const ids = [...new Set(userIds)].filter(isUuid);
    const out = new Map<string, LiveFacts>();
    if (!ids.length) return out;
    // One round trip: each person's newest sample, device and agent session (indexed lookups).
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        sample_at: Date | null;
        sample_idle: boolean | null;
        seen_at: Date | null;
        agent_version: string | null;
        activated_at: Date | null;
      }[]
    >`
      SELECT u.id::text AS id,
             s.at AS sample_at,
             (s.idle OR s.locked) AS sample_idle,
             COALESCE(d.last_seen, t.created_at) AS seen_at,
             COALESCE(d.agent_version, substring(t.user_agent FROM 'RXVisionAgent/([0-9][0-9.]*)')) AS agent_version,
             u.agent_activated_at AS activated_at
        FROM users u
        LEFT JOIN LATERAL (
          SELECT a.at, a.idle, a.locked FROM activity_samples a
           WHERE a.user_id = u.id ORDER BY a.at DESC LIMIT 1
        ) s ON TRUE
        LEFT JOIN LATERAL (
          SELECT v.last_seen, v.agent_version FROM devices v
           WHERE v.user_id = u.id AND v.deleted_at IS NULL ORDER BY v.last_seen DESC LIMIT 1
        ) d ON TRUE
        -- The agent's newest session (its User-Agent names the version; sessions
        -- renew every few minutes while it runs).
        LEFT JOIN LATERAL (
          SELECT r.user_agent, r.created_at FROM refresh_tokens r
           WHERE r.user_id = u.id AND r.user_agent LIKE 'RXVisionAgent/%'
           ORDER BY r.created_at DESC LIMIT 1
        ) t ON TRUE
       WHERE u.id = ANY(${ids}::uuid[])`;
    for (const r of rows) {
      out.set(r.id, {
        lastSampleAt: r.sample_at,
        lastSampleIdle: r.sample_idle === true,
        lastSeenAt: r.seen_at,
        agentVersion: r.agent_version,
        agentActivatedAt: r.activated_at,
      });
    }
    return out;
  }

  async orgAdminCount(companyId: string): Promise<number> {
    if (!isUuid(companyId)) return 0;
    return this.prisma.user.count({
      where: { companyId, deletedAt: null, status: 'ACTIVE', role: { name: 'ADMIN' } },
    });
  }

  async companyName(companyId: string): Promise<string | null> {
    if (!isUuid(companyId)) return null;
    const row = await this.prisma.company.findFirst({
      where: { id: companyId },
      select: { name: true },
    });
    return row?.name ?? null;
  }
}
