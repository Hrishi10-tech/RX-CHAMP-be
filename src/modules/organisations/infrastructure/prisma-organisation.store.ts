import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { PrismaService } from '@shared/database/prisma.service';
import { lockOrganisation } from '@shared/database/org-lock';
import { isId } from '@shared/validation/is-id';
import { nameTaken } from '../domain/organisation.rules';
import {
  AssignOutcome,
  CreateAdminOutcome,
  DeleteOutcome,
  NameOutcome,
  NewOrgAdmin,
  OrgAdminRef,
  OrgCounts,
  OrgPerson,
  OrgRecord,
  OrgToday,
  OrganisationStore,
} from '../domain/organisation.store';

/** pg_advisory_xact_lock key serialising organisation name checks. */
const ORG_NAME_LOCK = 404_000_501;

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  status: true,
  companyId: true,
  company: { select: { deletedAt: true } },
  role: { select: { name: true } },
} as const;

type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON_SELECT }>;

function toPerson(r: PersonRow): OrgPerson {
  return {
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    role: r.role.name,
    status: r.status,
    companyId: r.companyId && r.company && r.company.deletedAt === null ? r.companyId : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class PrismaOrganisationStore implements OrganisationStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async list(): Promise<OrgRecord[]> {
    return this.prisma.company.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, createdAt: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }

  async findById(id: string): Promise<OrgRecord | null> {
    if (!isId(id)) return null;
    return this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, name: true, createdAt: true },
    });
  }

  private async lockNames(tx: Prisma.TransactionClient): Promise<{ id: string; name: string }[]> {
    await tx.$queryRaw`SELECT 1 AS ok FROM pg_advisory_xact_lock(${ORG_NAME_LOCK}::bigint)`;
    return tx.company.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
  }

  async create(name: string, actorId: string): Promise<NameOutcome> {
    return this.prisma.$transaction(async (tx) => {
      if (nameTaken(await this.lockNames(tx), name))
        return { ok: false, reason: 'NAME_TAKEN' } as const;
      const org = await tx.company.create({
        data: { name },
        select: { id: true, name: true, createdAt: true },
      });
      await this.audit.record(
        {
          actorId,
          action: 'ORG_CREATED',
          entity: 'ORGANISATION',
          entityId: org.id,
          metadata: { name },
        },
        tx,
      );
      return { ok: true, org } as const;
    });
  }

  async rename(id: string, name: string, actorId: string): Promise<NameOutcome> {
    if (!isId(id)) return { ok: false, reason: 'NOT_FOUND' };
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.lockNames(tx);
      const current = existing.find((o) => o.id === id);
      if (!current) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (nameTaken(existing, name, id)) return { ok: false, reason: 'NAME_TAKEN' } as const;
      const org = await tx.company.update({
        where: { id },
        data: { name },
        select: { id: true, name: true, createdAt: true },
      });
      await this.audit.record(
        {
          actorId,
          action: 'ORG_RENAMED',
          entity: 'ORGANISATION',
          entityId: id,
          metadata: { from: current.name, to: name },
        },
        tx,
      );
      return { ok: true, org } as const;
    });
  }

  async countActivePeople(id: string): Promise<number> {
    if (!isId(id)) return 0;
    return this.prisma.user.count({ where: { companyId: id, deletedAt: null, status: 'ACTIVE' } });
  }

  async softDelete(id: string, actorId: string): Promise<DeleteOutcome> {
    if (!isId(id)) return { ok: false, reason: 'NOT_FOUND' };
    const at = new Date();
    return this.prisma.$transaction(async (tx) => {
      // The row lock orders this delete against every addition to the organisation
      // (people, departments, assignments): the count below sees all of them.
      if (!(await lockOrganisation(tx, id))) return { ok: false, reason: 'NOT_FOUND' } as const;
      const active = await tx.user.count({
        where: { companyId: id, deletedAt: null, status: 'ACTIVE' },
      });
      if (active > 0) return { ok: false, reason: 'NOT_EMPTY', active } as const;
      const people = await tx.user.updateMany({
        where: { companyId: id, deletedAt: null },
        data: { deletedAt: at },
      });
      const departments = await tx.department.updateMany({
        where: { companyId: id, deletedAt: null },
        data: { deletedAt: at },
      });
      await tx.signOutKey.updateMany({
        where: { companyId: id, revokedAt: null },
        data: { revokedAt: at },
      });
      const org = await tx.company.update({
        where: { id },
        data: { deletedAt: at },
        select: { name: true },
      });
      await this.audit.record(
        {
          actorId,
          action: 'ORG_DELETED',
          entity: 'ORGANISATION',
          entityId: id,
          metadata: {
            name: org.name,
            peopleRemoved: people.count,
            departmentsRemoved: departments.count,
          },
        },
        tx,
      );
      return { ok: true, membersRemoved: people.count } as const;
    });
  }

  async admins(ids: string[]): Promise<Map<string, OrgAdminRef>> {
    const out = new Map<string, OrgAdminRef>();
    const wanted = ids.filter(isId);
    if (!wanted.length) return out;
    const rows = await this.prisma.user.findMany({
      where: { companyId: { in: wanted }, deletedAt: null, role: { name: 'ADMIN' } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        status: true,
        companyId: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const r of rows) {
      if (!r.companyId || out.has(r.companyId)) continue;
      out.set(r.companyId, {
        id: r.id,
        name: `${r.firstName} ${r.lastName}`.trim(),
        email: r.email,
        status: r.status,
      });
    }
    return out;
  }

  async counts(ids: string[]): Promise<Map<string, OrgCounts>> {
    const out = new Map<string, OrgCounts>();
    const wanted = ids.filter(isId);
    for (const id of wanted) out.set(id, { staff: 0, managers: 0, departments: 0 });
    if (!wanted.length) return out;
    const [people, roles, departments] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['companyId', 'roleId'],
        where: { companyId: { in: wanted }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.role.findMany({ select: { id: true, name: true } }),
      this.prisma.department.groupBy({
        by: ['companyId'],
        where: { companyId: { in: wanted }, deletedAt: null },
        _count: { _all: true },
      }),
    ]);
    const roleName = new Map(roles.map((r) => [r.id, r.name] as const));
    for (const p of people) {
      const c = p.companyId ? out.get(p.companyId) : undefined;
      if (!c) continue;
      const role = roleName.get(p.roleId);
      if (role === 'USER') c.staff += p._count._all;
      else if (role === 'MANAGER') c.managers += p._count._all;
    }
    for (const d of departments) {
      const c = out.get(d.companyId);
      if (c) c.departments = d._count._all;
    }
    return out;
  }

  async today(ids: string[], dateKey: string): Promise<Map<string, OrgToday>> {
    const out = new Map<string, OrgToday>();
    const wanted = ids.filter(isId);
    for (const id of wanted) out.set(id, { started: 0, working: 0, onBreak: 0, notStarted: 0 });
    if (!wanted.length) return out;
    // One aggregated query: active Staff and Managers of these organisations, their
    // work sessions dated today (open = working) and open break or lunch presence.
    const rows = await this.prisma.$queryRaw<
      {
        company_id: string;
        started: number;
        working: number;
        on_break: number;
        not_started: number;
      }[]
    >`
      WITH people AS (
        SELECT u.id, u.company_id
        FROM users u
        JOIN roles r ON r.id = u.role_id
        WHERE u.deleted_at IS NULL
          AND u.status = 'ACTIVE'
          AND r.name IN ('USER', 'MANAGER')
          AND u.company_id = ANY(${wanted}::uuid[])
      ),
      day AS (
        SELECT ws.user_id, bool_or(ws.ended_at IS NULL) AS open
        FROM work_sessions ws
        JOIN people p ON p.id = ws.user_id
        WHERE ws.date = ${dateKey}
        GROUP BY ws.user_id
      ),
      brk AS (
        SELECT DISTINCT ps.user_id
        FROM presence_sessions ps
        JOIN people p ON p.id = ps.user_id
        WHERE ps.ended_at IS NULL AND ps.type IN ('BREAK', 'LUNCH')
      )
      SELECT p.company_id::text AS company_id,
             count(d.user_id)::int AS started,
             (count(*) FILTER (WHERE d.open AND b.user_id IS NULL))::int AS working,
             (count(*) FILTER (WHERE d.open AND b.user_id IS NOT NULL))::int AS on_break,
             (count(*) FILTER (WHERE d.user_id IS NULL))::int AS not_started
      FROM people p
      LEFT JOIN day d ON d.user_id = p.id
      LEFT JOIN brk b ON b.user_id = p.id
      GROUP BY p.company_id
    `;
    for (const r of rows) {
      out.set(r.company_id, {
        started: Number(r.started),
        working: Number(r.working),
        onBreak: Number(r.on_break),
        notStarted: Number(r.not_started),
      });
    }
    return out;
  }

  private unassignedWhere(): Prisma.UserWhereInput {
    return {
      deletedAt: null,
      role: { name: { not: 'SUPER_ADMIN' } },
      OR: [{ companyId: null }, { company: { deletedAt: { not: null } } }],
    };
  }

  async listUnassigned(): Promise<OrgPerson[]> {
    const rows = await this.prisma.user.findMany({
      where: this.unassignedWhere(),
      select: PERSON_SELECT,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map(toPerson);
  }

  async countUnassigned(): Promise<number> {
    return this.prisma.user.count({ where: this.unassignedWhere() });
  }

  async findPerson(id: string): Promise<OrgPerson | null> {
    if (!isId(id)) return null;
    const row = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: PERSON_SELECT,
    });
    return row ? toPerson(row) : null;
  }

  async hasAdmin(companyId: string): Promise<boolean> {
    const row = await this.prisma.user.findFirst({
      where: { companyId, deletedAt: null, role: { name: 'ADMIN' } },
      select: { id: true },
    });
    return row !== null;
  }

  async createAdmin(data: NewOrgAdmin, actorId: string): Promise<CreateAdminOutcome> {
    // Email is unique across every account, deleted ones included.
    const holder = await this.prisma.user.findUnique({
      where: { email: data.email },
      select: { id: true },
    });
    if (holder) return { ok: false, reason: 'EMAIL_IN_USE' };
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The organisation row lock makes "one Admin per organisation" hold under races.
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id::text AS id FROM companies WHERE id = ${data.companyId}::uuid AND deleted_at IS NULL FOR UPDATE
        `;
        if (!locked.length) return { ok: false, reason: 'ORG_NOT_FOUND' } as const;
        const existing = await tx.user.findFirst({
          where: { companyId: data.companyId, deletedAt: null, role: { name: 'ADMIN' } },
          select: { id: true },
        });
        if (existing) return { ok: false, reason: 'ADMIN_EXISTS' } as const;
        const role = await tx.role.findUniqueOrThrow({
          where: { name: 'ADMIN' },
          select: { id: true },
        });
        const created = await tx.user.create({
          data: {
            email: data.email,
            passwordHash: data.passwordHash,
            firstName: data.firstName,
            lastName: data.lastName,
            roleId: role.id,
            companyId: data.companyId,
            shiftStart: '10:00',
            shiftEnd: '19:00',
          },
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
            companyId: true,
            createdAt: true,
          },
        });
        await this.audit.record(
          {
            actorId,
            action: 'ORG_ADMIN_CREATED',
            entity: 'USER',
            entityId: created.id,
            metadata: { companyId: data.companyId, email: data.email },
          },
          tx,
        );
        return { ok: true, admin: { ...created, companyId: data.companyId } } as const;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'EMAIL_IN_USE' };
      throw err;
    }
  }

  async assignPerson(userId: string, companyId: string, actorId: string): Promise<AssignOutcome> {
    return this.prisma.$transaction(async (tx) => {
      // The organisation's row lock: no delete in between, and "one Admin per
      // organisation" holds against createAdmin (which takes the same lock).
      if (!(await lockOrganisation(tx, companyId))) {
        return { ok: false, reason: 'ORG_NOT_FOUND' } as const;
      }
      const before = await tx.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: {
          companyId: true,
          company: { select: { deletedAt: true } },
          role: { select: { name: true } },
        },
      });
      if (!before) return { ok: false, reason: 'PERSON_NOT_FOUND' } as const;
      const current = before.company && before.company.deletedAt === null ? before.companyId : null;
      if (current === companyId) return { ok: true, changed: false } as const;
      if (current) return { ok: false, reason: 'PERSON_IN_ORGANISATION' } as const;
      if (before.role.name === 'ADMIN') {
        const admin = await tx.user.findFirst({
          where: { companyId, deletedAt: null, role: { name: 'ADMIN' }, NOT: { id: userId } },
          select: { id: true },
        });
        if (admin) return { ok: false, reason: 'ADMIN_EXISTS' } as const;
      }
      await tx.managerDepartment.deleteMany({ where: { managerId: userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          companyId,
          departmentId: null,
          managerId: null,
          grantScreenshots: false,
          grantTimeline: false,
          grantActivity: false,
        },
      });
      await this.audit.record(
        {
          actorId,
          action: 'ORG_PERSON_ASSIGNED',
          entity: 'USER',
          entityId: userId,
          metadata: { from: before.companyId, to: companyId },
        },
        tx,
      );
      return { ok: true, changed: true } as const;
    });
  }
}
