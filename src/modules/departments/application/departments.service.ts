import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditLogService } from '@shared/audit/audit-log.service';
import { PrismaService } from '@shared/database/prisma.service';
import { lockOrganisation, orgNotFound } from '@shared/database/org-lock';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { isAdminLike, requireOrg, visibleDeptIds } from '@shared/tenancy';
import { isId } from '@shared/validation/is-id';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { IdleSettingsService } from '@modules/settings/application/idle-settings.service';
import { idleFromStored } from '@modules/settings/domain/idle.rules';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import {
  DEFAULT_DEPARTMENT_ICON,
  departmentNameKey,
  departmentNameProblem,
  isDepartmentIcon,
  normaliseDepartmentName,
} from '../domain/department.rules';

/** GET /departments item (docs/4.0/SPEC.md 5.2). */
export interface DepartmentView {
  id: string;
  name: string;
  icon: string;
  /** Active Staff in the department. */
  staffCount: number;
  managers: { id: string; name: string }[];
  /** The department's input-tracking override (nulls = organisation default). */
  idle: { enabled: boolean | null; minutes: number | null; reasonKeys: string[] | null };
  createdAt: string;
}

export interface DepartmentInput {
  name?: string;
  icon?: string;
}

type DeptRow = { id: string; name: string; icon: string; createdAt: Date };

const DEPT_SELECT = { id: true, name: true, icon: true, createdAt: true } as const;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function exists(name: string): ConflictError {
  return new ConflictError(`A department called "${name}" already exists.`, 'DEPARTMENT_EXISTS');
}

/**
 * Departments of an organisation (docs/4.0/SPEC.md 2.1, 5.2). Admins and Super
 * Admins (inside an organisation) manage them; Managers read their own.
 *
 * The free-text users.department and the shift assignments' department /
 * department_key follow the department's name, so a rename moves them in the same
 * transaction and 3.x shift matching keeps working.
 */
@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
    private readonly idle: IdleSettingsService,
    private readonly days: BreakDayService,
    private readonly audit: AuditLogService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async list(me: AuthenticatedUser): Promise<DepartmentView[]> {
    const org = requireOrg(me);
    if (!isAdminLike(me) && me.role !== Role.MANAGER) {
      throw new ForbiddenError('Departments are managed by your organisation admin.');
    }
    const only = visibleDeptIds(me);
    if (only && only.length === 0) return [];
    const rows = await this.prisma.department.findMany({
      where: { companyId: org, deletedAt: null, ...(only ? { id: { in: only } } : {}) },
      select: DEPT_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return this.views(org, rows);
  }

  async create(me: AuthenticatedUser, input: DepartmentInput): Promise<DepartmentView> {
    const org = this.adminOrg(me);
    const name = this.checkedName(input.name);
    const icon = this.checkedIcon(input.icon ?? DEFAULT_DEPARTMENT_ICON);
    await this.assertNameFree(org, name, null);
    let row: DeptRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        // The organisation's row lock orders this against its deletion: a deleted
        // (or deleting) organisation gets no new department (404 ORG_NOT_FOUND).
        if (!(await lockOrganisation(tx, org))) throw orgNotFound();
        const created = await tx.department.create({
          data: { companyId: org, name, icon },
          select: DEPT_SELECT,
        });
        await this.audit.record(
          {
            actorId: me.id,
            action: 'DEPARTMENT_CREATED',
            entity: 'DEPARTMENT',
            entityId: created.id,
            metadata: { companyId: org, name, icon },
          },
          tx,
        );
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw exists(name);
      throw err;
    }
    return (await this.views(org, [row]))[0];
  }

  async update(me: AuthenticatedUser, id: string, input: DepartmentInput): Promise<DepartmentView> {
    const org = this.adminOrg(me);
    const current = await this.findInOrg(org, id);
    const name = input.name !== undefined ? this.checkedName(input.name) : current.name;
    const icon = input.icon !== undefined ? this.checkedIcon(input.icon) : current.icon;
    const renamed = name !== current.name;
    if (renamed) await this.assertNameFree(org, name, current.id);
    if (!renamed && icon === current.icon) return (await this.views(org, [current]))[0];

    let row: DeptRow;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.department.update({
          where: { id: current.id },
          data: { name, icon },
          select: DEPT_SELECT,
        });
        if (renamed) {
          // The display text and the 3.x shift matching follow the name.
          await tx.user.updateMany({
            where: { departmentId: current.id, deletedAt: null },
            data: { department: name },
          });
          await tx.shiftAssignment.updateMany({
            where: {
              target: 'DEPARTMENT',
              companyId: org,
              departmentKey: departmentNameKey(current.name),
            },
            data: { department: name, departmentKey: departmentNameKey(name) },
          });
        }
        await this.audit.record(
          {
            actorId: me.id,
            action: 'DEPARTMENT_UPDATED',
            entity: 'DEPARTMENT',
            entityId: current.id,
            metadata: {
              companyId: org,
              ...(renamed ? { from: current.name, to: name } : {}),
              ...(icon !== current.icon ? { iconFrom: current.icon, iconTo: icon } : {}),
            },
          },
          tx,
        );
        return updated;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw exists(name);
      throw err;
    }
    if (renamed) this.days.invalidate();
    return (await this.views(org, [row]))[0];
  }

  async remove(me: AuthenticatedUser, id: string): Promise<{ deleted: true; id: string }> {
    const org = this.adminOrg(me);
    const current = await this.findInOrg(org, id);
    const staff = await this.prisma.user.count({
      where: {
        departmentId: current.id,
        deletedAt: null,
        status: 'ACTIVE',
        role: { name: 'USER' },
      },
    });
    if (staff > 0) {
      throw new ConflictError(
        `${staff} staff ${staff === 1 ? 'member is' : 'members are'} still in ${current.name}. ` +
          'Move them to another department first.',
        'DEPARTMENT_NOT_EMPTY',
      ).withDetails({ staff });
    }

    const managers = await this.prisma.$transaction(async (tx) => {
      const links = await tx.managerDepartment.findMany({
        where: { departmentId: current.id },
        select: { managerId: true },
      });
      await tx.managerDepartment.deleteMany({ where: { departmentId: current.id } });
      // Managers whose own department this was, and blocked staff, keep no link to it.
      await tx.user.updateMany({
        where: { departmentId: current.id },
        data: { departmentId: null },
      });
      await tx.department.update({ where: { id: current.id }, data: { deletedAt: new Date() } });
      await this.audit.record(
        {
          actorId: me.id,
          action: 'DEPARTMENT_DELETED',
          entity: 'DEPARTMENT',
          entityId: current.id,
          metadata: { companyId: org, name: current.name, managersUnassigned: links.length },
        },
        tx,
      );
      return links.map((l) => l.managerId);
    });

    await this.idle.removeDepartment(org, current.id, me.id);
    this.days.invalidate();
    // Unassigned managers reconnect their live sockets with the rooms they still have.
    const now = new Date();
    for (const managerId of new Set(managers)) {
      await this.events.publish(
        UserAccessChangedEvent.eventName,
        new UserAccessChangedEvent(managerId, ['ROLE'], now),
      );
    }
    return { deleted: true, id: current.id };
  }

  // ---- helpers -------------------------------------------------------------------

  private adminOrg(me: AuthenticatedUser): string {
    const org = requireOrg(me);
    if (!isAdminLike(me)) {
      throw new ForbiddenError('Only the organisation admin can change departments.');
    }
    return org;
  }

  private async findInOrg(org: string, id: string): Promise<DeptRow> {
    const row = isId(id)
      ? await this.prisma.department.findFirst({
          where: { id, companyId: org, deletedAt: null },
          select: DEPT_SELECT,
        })
      : null;
    if (!row) throw new NotFoundError('That department does not exist.', 'DEPARTMENT_NOT_FOUND');
    return row;
  }

  private checkedName(raw: unknown): string {
    const problem = departmentNameProblem(raw);
    if (problem) throw new ValidationError(problem).withDetails({ field: 'name' });
    return normaliseDepartmentName(raw as string);
  }

  private checkedIcon(raw: unknown): string {
    if (!isDepartmentIcon(raw)) {
      throw new ValidationError('Pick an icon from the list.', 'DEPARTMENT_ICON').withDetails({
        field: 'icon',
      });
    }
    return raw;
  }

  /** Friendly 409 before the unique index would refuse it (the index still decides races). */
  private async assertNameFree(org: string, name: string, exceptId: string | null): Promise<void> {
    const key = departmentNameKey(name);
    const others = await this.prisma.department.findMany({
      where: { companyId: org, deletedAt: null },
      select: { id: true, name: true },
    });
    if (others.some((d) => d.id !== exceptId && departmentNameKey(d.name) === key))
      throw exists(name);
  }

  /** Views for these departments: one query per table, whatever their number. */
  private async views(org: string, rows: DeptRow[]): Promise<DepartmentView[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [staff, links, raw] = await Promise.all([
      this.prisma.user.groupBy({
        by: ['departmentId'],
        where: {
          departmentId: { in: ids },
          deletedAt: null,
          status: 'ACTIVE',
          role: { name: 'USER' },
        },
        _count: { _all: true },
      }),
      this.prisma.managerDepartment.findMany({
        where: {
          departmentId: { in: ids },
          manager: { deletedAt: null, role: { name: 'MANAGER' } },
        },
        select: {
          departmentId: true,
          manager: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      this.settings.readRaw(org),
    ]);
    const staffBy = new Map(staff.map((s) => [s.departmentId, s._count._all] as const));
    const managersBy = new Map<string, { id: string; name: string }[]>();
    for (const l of links) {
      const list = managersBy.get(l.departmentId) ?? [];
      list.push({ id: l.manager.id, name: `${l.manager.firstName} ${l.manager.lastName}`.trim() });
      managersBy.set(l.departmentId, list);
    }
    const idle = idleFromStored(raw).departments;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      icon: r.icon,
      staffCount: staffBy.get(r.id) ?? 0,
      managers: (managersBy.get(r.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
      idle: {
        enabled: idle[r.id]?.enabled ?? null,
        minutes: idle[r.id]?.minutes ?? null,
        reasonKeys: idle[r.id]?.reasonKeys ?? null,
      },
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
