import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { LOCK_SCREEN_APP, MAX_GAP_SEC } from '@modules/activity/application/activity.constants';
import { isUuid } from '@modules/shifts/infrastructure/prisma-shift.repository';
import { COVERAGE_JOIN_SEC } from '../domain/focus';
import { IDLE_LEAD_IN_SEC } from '../domain/input-activity';
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

/** Person-days per hour-bucket query (see activeSecByHour). */
const HOUR_BUCKET_BATCH = 500;

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
    now: Date = new Date(),
  ): Promise<HourBucketRow[]> {
    if (!days.length) return [];
    // A few hundred person-days a query keeps each sort in memory (about 40 MB).
    const out: HourBucketRow[] = [];
    for (let i = 0; i < days.length; i += HOUR_BUCKET_BATCH) {
      out.push(...(await this.activeSecByHourBatch(days.slice(i, i + HOUR_BUCKET_BATCH), tz, now)));
    }
    return out;
  }

  private async activeSecByHourBatch(
    days: { userId: string; date: string }[],
    tz: string,
    now: Date,
  ): Promise<HourBucketRow[]> {
    // Keyboard and mouse input per local hour, on the rules of input-activity.ts
    // (Fix 10), so reports and Team today agree with every other screen:
    //   - each sample stands for its stamped span, capped at 150 s; the newest open
    //     one stands until now;
    //   - per PC, the 300 s before an idle flag (not a lock) was idle, not work;
    //   - input on two PCs at once counts once (a union, not a sum);
    //   - only time inside a work session of the day, filed under that day and
    //     split exactly at local hour boundaries (a night shift's hours after
    //     midnight stay on its day).
    // Timestamps are timestamp(3) holding UTC. JIT compiles this query for longer
    // than it runs.
    const nowIso = now.toISOString();
    // Samples are read per work session (an index range each, as in 3.1), from one
    // sample span before it to one idle threshold after it: enough for every rule.
    // Everything after the read is plain arithmetic on epoch seconds; the local hour
    // uses each session's UTC offset (one lookup per session, not per sample).
    const [, , rows] = await this.prisma.$transaction([
      this.prisma.$executeRaw`SET LOCAL jit = off`,
      this.prisma.$executeRaw`SET LOCAL work_mem = '96MB'`,
      this.prisma.$queryRaw<{ user_id: string; date: string; hour: number; active_sec: number }[]>`
        WITH params AS (
          SELECT (${nowIso}::timestamptz AT TIME ZONE 'UTC') AS now_utc
        ),
        ws AS (
          SELECT ws.id AS ws_id, ws.user_id, ws.date,
                 ws.started_at AS ws_start,
                 COALESCE(ws.ended_at, p.now_utc) AS ws_end,
                 EXTRACT(EPOCH FROM ws.started_at)::float8 AS start_e,
                 EXTRACT(EPOCH FROM COALESCE(ws.ended_at, p.now_utc))::float8 AS end_e,
                 (EXTRACT(EPOCH FROM ((ws.started_at AT TIME ZONE 'UTC') AT TIME ZONE ${tz}))
                  - EXTRACT(EPOCH FROM ws.started_at))::float8 AS off_e,
                 EXTRACT(EPOCH FROM p.now_utc)::float8 AS now_e
            FROM unnest(${days.map((d) => d.userId)}::uuid[], ${days.map((d) => d.date)}::text[])
                 AS d(user_id, date)
            JOIN work_sessions ws ON ws.user_id = d.user_id AND ws.date = d.date
           CROSS JOIN params p
        ),
        smp AS (
          -- One index range per session (LATERAL keeps the planner from scanning
          -- every sample and matching them against every session).
          SELECT ws.ws_id, s.device_id, s.e,
                 CASE
                   WHEN s.duration_sec > 0 THEN LEAST(s.duration_sec, ${MAX_GAP_SEC})::float8
                   -- Only the newest sample of all is still open: it stands until now.
                   WHEN NOT EXISTS (
                     SELECT 1 FROM activity_samples x WHERE x.user_id = ws.user_id AND x.at > s.at
                   ) THEN LEAST(GREATEST(ws.now_e - s.e, 0), ${MAX_GAP_SEC})::float8
                   ELSE 0
                 END AS len_sec,
                 s.idle_flag, s.lock_flag
            FROM ws
           CROSS JOIN LATERAL (
             SELECT a.at, a.duration_sec,
                    a.device_id,
                    EXTRACT(EPOCH FROM a.at)::float8 AS e,
                    (a.idle OR a.locked OR COALESCE(a.app = ${LOCK_SCREEN_APP}, false)) AS idle_flag,
                    (a.locked OR COALESCE(a.app = ${LOCK_SCREEN_APP}, false)) AS lock_flag
               FROM activity_samples a
              WHERE a.user_id = ws.user_id
                AND a.at >= ws.ws_start - make_interval(secs => ${MAX_GAP_SEC})
                AND a.at <  ws.ws_end + make_interval(secs => ${IDLE_LEAD_IN_SEC})
             OFFSET 0
           ) AS s
        ),
        cut AS (
          -- The first idle sample after this one on the same PC starts an idle
          -- stretch. Its lead-in (the 300 s before it) was idle, unless it is a lock:
          -- a lock is the instant work stopped, and the lead-ins of later stretches
          -- never reach back past it.
          SELECT ws_id, e, len_sec, idle_flag,
                 min(CASE WHEN idle_flag AND NOT lock_flag THEN e END) OVER later AS next_idle_e,
                 min(CASE WHEN lock_flag THEN e END) OVER later AS next_lock_e
            FROM smp
          WINDOW later AS (PARTITION BY ws_id, device_id ORDER BY e DESC
                           ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
        ),
        act AS (
          SELECT ws_id,
                 e AS a0,
                 LEAST(e + len_sec,
                       CASE
                         WHEN next_idle_e IS NOT NULL
                              AND (next_lock_e IS NULL OR next_idle_e < next_lock_e)
                           THEN next_idle_e - ${IDLE_LEAD_IN_SEC}
                         ELSE 'Infinity'::float8
                       END) AS a1
            FROM cut
           WHERE NOT idle_flag AND len_sec > 0
        ),
        uni AS (
          -- Union across PCs: each piece starts after everything that started before it.
          SELECT ws_id,
                 GREATEST(a0, COALESCE(max(a1) OVER (PARTITION BY ws_id ORDER BY a0, a1
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), a0)) AS u0,
                 a1 AS u1
            FROM act
           WHERE a1 > a0
        ),
        ins AS (
          SELECT ws.user_id, ws.date, ws.off_e,
                 GREATEST(uni.u0, ws.start_e) AS x0,
                 LEAST(uni.u1, ws.end_e) AS x1
            FROM uni
            JOIN ws ON ws.ws_id = uni.ws_id
           WHERE uni.u1 > uni.u0
        ),
        hrs AS (
          -- A piece is at most 150 s long, so it lies in one local hour or two.
          SELECT user_id, date, x0, x1,
                 floor((x0 + off_e) / 3600)::bigint AS h,
                 (floor((x0 + off_e) / 3600) + 1) * 3600 - off_e AS split
            FROM ins
           WHERE x1 > x0
        ),
        parts AS (
          SELECT user_id, date, mod(h, 24)::int AS hour, LEAST(x1, split) - x0 AS sec FROM hrs
          UNION ALL
          SELECT user_id, date, mod(h + 1, 24)::int AS hour, x1 - split AS sec FROM hrs WHERE x1 > split
        )
        SELECT user_id::text AS user_id, date, hour, ROUND(SUM(sec))::int AS active_sec
          FROM parts
         WHERE sec > 0
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
