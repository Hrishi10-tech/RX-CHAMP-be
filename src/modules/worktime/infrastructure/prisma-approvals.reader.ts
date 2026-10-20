import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { ApproverRole } from '@modules/shifts/domain/shift.types';
import {
  ApprovalQuery,
  ApprovalRef,
  ApprovalScope,
  ApprovalsReader,
  ApprovalType,
  DigestRow,
  SlaClaim,
} from '../domain/approvals.reader';
import { DIGEST_DUE_MS, DUE_SOON_MS } from '../domain/sla';

/** A JS instant as a timestamp(3)-comparable UTC value (independent of the DB time zone). */
function ts(d: Date): Prisma.Sql {
  return Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * Every kind of approval item as one relation `a`, with the category worked out
 * the same way as breakCategory() (the overrun wins over early or late; an
 * on-time break can only be waiting because of its overrun). 4.0 adds away
 * events (AWAY_<kind>), which carry no approver id.
 */
const ITEMS = Prisma.sql`(
  SELECT 'BREAK'::text AS type, b.id, b.user_id, b.date, b.approval_status::text AS status,
         b.due_at, b.decided_at, b.created_at, b.escalated_at, b.reminded_at,
         b.approver_id, b.approver_role::text AS approver_role,
         CASE WHEN b.outcome = 'SKIPPED' THEN 'BREAK_SKIP'
              WHEN b.outcome = 'AUTO_SKIPPED' THEN 'BREAK_AUTO_SKIP'
              WHEN b.overrun_asked OR b.timing = 'ON_TIME' THEN 'BREAK_OVERRUN'
              WHEN b.timing = 'EARLY' THEN 'BREAK_EARLY'
              WHEN b.timing = 'LATE' THEN 'BREAK_LATE'
              WHEN b.timing = 'OUTSIDE_WINDOW' THEN 'BREAK_OUTSIDE'
              ELSE 'BREAK_UNSCHEDULED' END AS category
    FROM break_records b
   WHERE b.approval_status <> 'NOT_REQUIRED'
  UNION ALL
  SELECT 'MEETING'::text, m.id, m.user_id, m.date, m.approval_status::text,
         m.due_at, m.decided_at, m.created_at, m.escalated_at, m.reminded_at,
         m.approver_id, m.approver_role::text,
         CASE WHEN m.mode = 'LIVE' THEN 'MEETING_LIVE' ELSE 'MEETING_PAST' END
    FROM meeting_records m
   WHERE m.approval_status <> 'NOT_REQUIRED'
  UNION ALL
  SELECT 'AWAY'::text, w.id, w.user_id, w.date, w.status::text,
         w.due_at, w.decided_at, w.created_at, w.escalated_at, w.reminded_at,
         NULL::uuid, w.approver_role::text,
         'AWAY_' || CASE WHEN w.reason_kind IN ('THINKING', 'MEETING', 'HARDWARE', 'OTHER', 'CUSTOM')
                         THEN w.reason_kind ELSE 'OTHER' END
    FROM away_events w
   WHERE w.status IN ('PENDING', 'APPROVED', 'REJECTED')
) a`;

/** The subject belongs to the organisation. */
function inOrg(companyId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM users su WHERE su.id = a.user_id AND su.company_id = ${companyId}::uuid)`;
}

function scopeSql(scope: ApprovalScope): Prisma.Sql {
  switch (scope.kind) {
    case 'ALL':
      return Prisma.sql`TRUE`;
    case 'SUBJECT':
      return Prisma.sql`a.user_id = ${scope.userId}::uuid`;
    case 'ORG':
      return Prisma.sql`${inOrg(scope.companyId)} AND a.user_id <> ${scope.excludeUserId}::uuid`;
    case 'ORG_ADMIN_MINE':
      // Waiting for the Admin, escalated, or waiting for a department that has no
      // active manager right now (nobody else could decide it).
      return Prisma.sql`${inOrg(scope.companyId)} AND a.user_id <> ${scope.excludeUserId}::uuid
        AND (a.approver_role IN ('ADMIN', 'SUPER_ADMIN') OR a.escalated_at IS NOT NULL
          OR (a.approver_role = 'MANAGER' AND NOT EXISTS (
            SELECT 1 FROM users su
              JOIN manager_departments md ON md.department_id = su.department_id
              JOIN users mu ON mu.id = md.manager_id AND mu.deleted_at IS NULL AND mu.status = 'ACTIVE'
              JOIN roles mr ON mr.id = mu.role_id AND mr.name = 'MANAGER'
              JOIN departments d ON d.id = md.department_id AND d.deleted_at IS NULL
             WHERE su.id = a.user_id AND mu.id <> a.user_id)))`;
    case 'DEPTS':
      if (!scope.departmentIds.length) return Prisma.sql`FALSE`;
      return Prisma.sql`EXISTS (
          SELECT 1 FROM users su JOIN roles sr ON sr.id = su.role_id
           WHERE su.id = a.user_id AND su.company_id = ${scope.companyId}::uuid
             AND sr.name = 'USER' AND su.department_id = ANY(${scope.departmentIds}::uuid[]))
        AND a.user_id <> ${scope.excludeUserId}::uuid`;
  }
}

function whereSql(q: ApprovalQuery): Prisma.Sql {
  const parts: Prisma.Sql[] = [scopeSql(q.scope)];
  if (q.statuses.length) parts.push(Prisma.sql`a.status IN (${Prisma.join(q.statuses)})`);
  if (q.type) parts.push(Prisma.sql`a.type = ${q.type}`);
  if (q.category) parts.push(Prisma.sql`a.category = ${q.category}`);
  if (q.overdueAt) parts.push(Prisma.sql`a.status = 'PENDING' AND a.due_at < ${ts(q.overdueAt)}`);
  if (q.dueWithin) {
    parts.push(
      Prisma.sql`a.due_at >= ${ts(q.dueWithin.from)} AND a.due_at <= ${ts(q.dueWithin.to)}`,
    );
  }
  if (q.escalatedOnly) parts.push(Prisma.sql`a.escalated_at IS NOT NULL`);
  if (q.date) parts.push(Prisma.sql`a.date = ${q.date}`);
  if (q.fromDate) parts.push(Prisma.sql`a.date >= ${q.fromDate}`);
  if (q.toDate) parts.push(Prisma.sql`a.date <= ${q.toDate}`);
  if (q.userId) parts.push(Prisma.sql`a.user_id = ${q.userId}::uuid`);
  if (q.userIds) parts.push(Prisma.sql`a.user_id = ANY(${q.userIds}::uuid[])`);
  return Prisma.join(parts, ' AND ');
}

type SlaTable = 'break_records' | 'meeting_records' | 'away_events';
const SLA_ITEMS = (table: SlaTable) => Prisma.raw(table);
/** The status column of each table. */
const STATUS_COL = (table: SlaTable) =>
  Prisma.raw(table === 'away_events' ? 'status' : 'approval_status');
const SLA_TABLES: [SlaTable, ApprovalType][] = [
  ['break_records', 'BREAK'],
  ['meeting_records', 'MEETING'],
  ['away_events', 'AWAY'],
];

@Injectable()
export class PrismaApprovalsReader implements ApprovalsReader {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: ApprovalQuery): Promise<{ total: number; refs: ApprovalRef[] }> {
    const where = whereSql(q);
    const [count, rows] = await Promise.all([
      this.prisma.$queryRaw<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM ${ITEMS} WHERE ${where}`,
      this.prisma.$queryRaw<{ type: ApprovalType; id: string }[]>`
        SELECT a.type, a.id::text AS id FROM ${ITEMS} WHERE ${where}
         ORDER BY (a.status = 'PENDING') DESC,
                  CASE WHEN a.status = 'PENDING' THEN a.due_at END ASC NULLS LAST,
                  COALESCE(a.decided_at, a.created_at) DESC,
                  a.id ASC
         LIMIT ${q.take ?? 50} OFFSET ${q.skip ?? 0}`,
    ]);
    return { total: count[0]?.n ?? 0, refs: rows.map((r) => ({ type: r.type, id: r.id })) };
  }

  async count(q: ApprovalQuery): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${ITEMS} WHERE ${whereSql(q)}`;
    return rows[0]?.n ?? 0;
  }

  async countDecidedBetween(
    scope: ApprovalScope,
    status: 'APPROVED' | 'REJECTED',
    from: Date,
    to: Date,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${ITEMS}
       WHERE ${scopeSql(scope)} AND a.status = ${status}
         AND a.decided_at >= ${ts(from)} AND a.decided_at < ${ts(to)}`;
    return rows[0]?.n ?? 0;
  }

  async overdueIn(
    scope: ApprovalScope,
    now: Date,
  ): Promise<{ count: number; oldestDueAt: Date | null }> {
    const rows = await this.prisma.$queryRaw<{ n: number; oldest: Date | null }[]>`
      SELECT count(*) FILTER (WHERE a.due_at < ${ts(now)})::int AS n, min(a.due_at) AS oldest
        FROM ${ITEMS}
       WHERE ${scopeSql(scope)} AND a.status = 'PENDING'`;
    return { count: rows[0]?.n ?? 0, oldestDueAt: rows[0]?.oldest ?? null };
  }

  private async slaCandidates(
    now: Date,
    column: 'reminded_at' | 'escalated_at',
  ): Promise<SlaClaim[]> {
    const col = Prisma.raw(column);
    const window =
      column === 'reminded_at'
        ? Prisma.sql`t.due_at >= ${ts(now)} AND t.due_at <= ${ts(new Date(now.getTime() + DUE_SOON_MS))}`
        : Prisma.sql`t.due_at < ${ts(now)}`;
    const from = (table: SlaTable, type: ApprovalType) => {
      const approverId =
        table === 'away_events' ? Prisma.sql`NULL::text` : Prisma.sql`t.approver_id::text`;
      return this.prisma.$queryRaw<
        {
          id: string;
          user_id: string;
          approver_id: string | null;
          approver_role: string | null;
          company_id: string | null;
          department_id: string | null;
        }[]
      >`
        SELECT t.id::text AS id, t.user_id::text AS user_id, ${approverId} AS approver_id,
               t.approver_role::text AS approver_role,
               u.company_id::text AS company_id, u.department_id::text AS department_id
          FROM ${SLA_ITEMS(table)} t JOIN users u ON u.id = t.user_id
         WHERE t.${STATUS_COL(table)} = 'PENDING' AND t.${col} IS NULL AND t.due_at IS NOT NULL AND ${window}
         LIMIT 5000`.then((rows) =>
        rows.map(
          (r): SlaClaim => ({
            type,
            id: r.id,
            userId: r.user_id,
            approverId: r.approver_id,
            approverRole: (r.approver_role as ApproverRole | null) ?? null,
            companyId: r.company_id,
            departmentId: r.department_id,
          }),
        ),
      );
    };
    const parts = await Promise.all(SLA_TABLES.map(([table, type]) => from(table, type)));
    return parts.flat();
  }

  private async markSla(
    refs: ApprovalRef[],
    now: Date,
    column: 'reminded_at' | 'escalated_at',
  ): Promise<number> {
    const col = Prisma.raw(column);
    const mark = async (table: SlaTable, type: ApprovalType) => {
      const ids = refs.filter((r) => r.type === type).map((r) => r.id);
      if (!ids.length) return 0;
      return this.prisma.$executeRaw`
        UPDATE ${SLA_ITEMS(table)} SET ${col} = ${ts(now)}
         WHERE id = ANY(${ids}::uuid[]) AND ${col} IS NULL`;
    };
    const counts = await Promise.all(SLA_TABLES.map(([table, type]) => mark(table, type)));
    return counts.reduce((a, b) => a + b, 0);
  }

  remindersDue(now: Date): Promise<SlaClaim[]> {
    return this.slaCandidates(now, 'reminded_at');
  }

  escalationsDue(now: Date): Promise<SlaClaim[]> {
    return this.slaCandidates(now, 'escalated_at');
  }

  markReminded(refs: ApprovalRef[], now: Date): Promise<number> {
    return this.markSla(refs, now, 'reminded_at');
  }

  markEscalated(refs: ApprovalRef[], now: Date): Promise<number> {
    return this.markSla(refs, now, 'escalated_at');
  }

  async fillMissingDueAt(slaHours: number): Promise<number> {
    const hours = Prisma.raw(`interval '${Math.round(slaHours)} hours'`);
    const fill = (table: SlaTable) =>
      this.prisma.$executeRaw`
        UPDATE ${SLA_ITEMS(table)} SET due_at = created_at + ${hours}
         WHERE ${STATUS_COL(table)} = 'PENDING' AND due_at IS NULL`;
    const counts = await Promise.all(SLA_TABLES.map(([table]) => fill(table)));
    return counts.reduce((a, b) => a + b, 0);
  }

  async digestCounts(now: Date): Promise<DigestRow[]> {
    const rows = await this.prisma.$queryRaw<
      {
        approver_role: string | null;
        company_id: string | null;
        department_id: string | null;
        pending: number;
        due_soon: number;
        overdue: number;
      }[]
    >`
      SELECT a.approver_role, u.company_id::text AS company_id, u.department_id::text AS department_id,
             count(*)::int AS pending,
             count(*) FILTER (WHERE a.due_at >= ${ts(now)}
                                AND a.due_at <= ${ts(new Date(now.getTime() + DIGEST_DUE_MS))})::int AS due_soon,
             count(*) FILTER (WHERE a.due_at < ${ts(now)})::int AS overdue
        FROM ${ITEMS} JOIN users u ON u.id = a.user_id
       WHERE a.status = 'PENDING'
       GROUP BY 1, 2, 3`;
    return rows.map((r) => ({
      approverId: null,
      approverRole: (r.approver_role as ApproverRole | null) ?? null,
      companyId: r.company_id,
      departmentId: r.department_id,
      pending: r.pending,
      dueSoon: r.due_soon,
      overdue: r.overdue,
    }));
  }

  async lockedMonths(companyIds: string[], months: string[]): Promise<Set<string>> {
    const wantedMonths = [...new Set(months)];
    const wantedOrgs = [...new Set(companyIds.filter(Boolean))];
    if (!wantedMonths.length || !wantedOrgs.length) return new Set();
    const rows = await this.prisma.monthLock.findMany({
      where: { month: { in: wantedMonths }, companyId: { in: wantedOrgs } },
      select: { month: true, companyId: true },
    });
    return new Set(rows.map((r) => `${r.companyId}|${r.month}`));
  }

  async pendingByUserDate(userIds: string[], fromDate: string, toDate: string, now: Date) {
    if (!userIds.length) return [];
    const rows = await this.prisma.$queryRaw<
      { user_id: string; date: string; pending: number; overdue: number }[]
    >`
      SELECT a.user_id::text AS user_id, a.date, count(*)::int AS pending,
             count(*) FILTER (WHERE a.due_at < ${ts(now)})::int AS overdue
        FROM ${ITEMS}
       WHERE a.status = 'PENDING' AND a.user_id = ANY(${userIds}::uuid[])
         AND a.date >= ${fromDate} AND a.date <= ${toDate}
       GROUP BY 1, 2`;
    return rows.map((r) => ({
      userId: r.user_id,
      date: r.date,
      pending: r.pending,
      overdue: r.overdue,
    }));
  }

  async pendingInMonth(companyId: string, month: string, userIds?: string[]): Promise<number> {
    if (userIds && !userIds.length) return 0;
    const people = userIds ? Prisma.sql`AND a.user_id = ANY(${userIds}::uuid[])` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${ITEMS}
       WHERE a.status = 'PENDING' AND left(a.date, 7) = ${month} AND ${inOrg(companyId)} ${people}`;
    return rows[0]?.n ?? 0;
  }
}
