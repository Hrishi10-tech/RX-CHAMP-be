import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { buildMeta, PaginationMeta } from '@shared/utils/pagination';
import { dateKeyInZone } from '@shared/utils/timezone';
import { resolveShift } from '../../domain/shift-resolution';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '../../domain/shift-people.reader';
import { NewAssignment, SHIFT_REPOSITORY, ShiftRepository } from '../../domain/shift.repository';
import { ShiftAssignmentRecord, ShiftRecord, departmentKey } from '../../domain/shift.types';
import { BreakDayService, ResolutionContext } from '../break-day.service';
import { AssignDepartmentDto, AssignPeopleDto, ListPeopleShiftsQueryDto } from '../dto';
import { ShiftMapper } from '../shift.mapper';
import { DepartmentAssignmentView, PersonShiftView } from '../shifts.types';

export interface AssignPeopleResult {
  assigned: string[];
  skipped: { id: string; reason: string }[];
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** Newest first: later effectiveFrom wins, then the most recently created. */
function newestFirst(a: ShiftAssignmentRecord, b: ShiftAssignmentRecord): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  return b.createdAt.getTime() - a.createdAt.getTime();
}

function inForce(a: ShiftAssignmentRecord, dateKey: string): boolean {
  return a.effectiveFrom <= dateKey && (!a.effectiveTo || a.effectiveTo >= dateKey);
}

/**
 * Who works which shift. Super Admin sets department shifts and may override
 * anyone; a Manager may override the shift of their own staff only.
 *
 * Changes are dated and never rewrite the past: a change applies from today or a
 * later day, and breaks already taken keep the schedule they were taken under.
 */
@Injectable()
export class ShiftAssignmentsUseCase {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
  ) {}

  private today(): string {
    return dateKeyInZone(new Date(), this.days.timezone);
  }

  private assertStaffManager(me: AuthenticatedUser): void {
    if (me.role !== Role.SUPER_ADMIN && me.role !== Role.MANAGER)
      throw new ForbiddenError('Not allowed');
  }

  private assertFromToday(effectiveFrom: string, today: string): void {
    if (effectiveFrom < today) {
      throw new ValidationError(
        'Pick today or a later day. Past days keep the shift they had.',
        'DATE_IN_PAST',
      );
    }
  }

  private async shiftOrNull(shiftId: string | null): Promise<ShiftRecord | null> {
    if (shiftId === null) return null;
    const shift = await this.shifts.findById(shiftId);
    if (!shift) throw new NotFoundError('Unknown shift');
    return shift;
  }

  // ---- Departments ---------------------------------------------------------

  async listDepartments(me: AuthenticatedUser): Promise<DepartmentAssignmentView[]> {
    this.assertStaffManager(me);
    const today = this.today();
    const everyone = await this.people.listAllActive();
    const scope =
      me.role === Role.MANAGER ? everyone.filter((p) => p.managerId === me.id) : everyone;
    const [departments, ctx] = await Promise.all([
      this.people.listDepartments(),
      this.days.context(scope.map((p) => p.id)),
    ]);

    // Which departments to show: those people are in (a Manager: their team's),
    // plus departments a Super Admin configured that are currently empty.
    const groups = new Map<
      string,
      { department: string; key: string; companyId: string | null; people: number }
    >();
    const visibleKeys = new Set(
      scope.map((p) => `${p.companyId ?? '-'}|${departmentKey(p.department)}`),
    );
    for (const d of departments) {
      const k = `${d.companyId ?? '-'}|${d.departmentKey}`;
      if (me.role === Role.MANAGER && !visibleKeys.has(k)) continue;
      groups.set(k, {
        department: d.department,
        key: d.departmentKey,
        companyId: d.companyId,
        people: d.people,
      });
    }
    if (me.role === Role.SUPER_ADMIN) {
      for (const a of ctx.assignments) {
        if (a.target !== 'DEPARTMENT' || !a.departmentKey || !a.department) continue;
        const k = `${a.companyId ?? '-'}|${a.departmentKey}`;
        if (!groups.has(k)) {
          groups.set(k, {
            department: a.department,
            key: a.departmentKey,
            companyId: a.companyId,
            people: 0,
          });
        }
      }
    }

    const overrides = new Map<string, number>();
    for (const p of scope) {
      const r = this.days.resolveWith(ctx, p, today);
      if (r.source !== 'OVERRIDE') continue;
      const k = `${p.companyId ?? '-'}|${departmentKey(p.department)}`;
      overrides.set(k, (overrides.get(k) ?? 0) + 1);
    }

    const views: DepartmentAssignmentView[] = [];
    for (const [k, g] of groups) {
      const current = this.departmentCurrent(ctx, g.companyId, g.key, today);
      const upcoming = this.departmentUpcoming(ctx, g.companyId, g.key, today);
      // An empty department that is back on the default shift, with nothing
      // planned, has nothing left to configure: leave it out of the list.
      if (g.people === 0 && !current?.shift && !upcoming) continue;
      views.push({
        department: g.department,
        departmentKey: g.key,
        companyId: g.companyId,
        people: g.people,
        current,
        upcoming,
        overrides: overrides.get(k) ?? 0,
      });
    }
    return views.sort((a, b) => a.department.localeCompare(b.department));
  }

  /** The department's shift today, exactly as resolution would pick it. */
  private departmentCurrent(
    ctx: ResolutionContext,
    companyId: string | null,
    key: string,
    today: string,
  ): DepartmentAssignmentView['current'] {
    const deptOnly = ctx.assignments.filter((a) => a.target === 'DEPARTMENT');
    const r = resolveShift(
      { id: '-', companyId, department: key },
      today,
      deptOnly,
      ctx.shiftsById,
      [],
    );
    if (r.source !== 'DEPARTMENT' || !r.assignment) return null;
    return { shift: ShiftMapper.ref(r.shift), effectiveFrom: r.assignment.effectiveFrom };
  }

  /** The next scheduled change for exactly this department scope. */
  private departmentUpcoming(
    ctx: ResolutionContext,
    companyId: string | null,
    key: string,
    today: string,
  ): DepartmentAssignmentView['upcoming'] {
    const next = ctx.assignments
      .filter(
        (a) =>
          a.target === 'DEPARTMENT' &&
          a.departmentKey === key &&
          (a.companyId === companyId || a.companyId === null) &&
          a.effectiveFrom > today,
      )
      .sort((a, b) =>
        a.effectiveFrom === b.effectiveFrom
          ? newestFirst(a, b)
          : a.effectiveFrom < b.effectiveFrom
            ? -1
            : 1,
      )[0];
    if (!next) return null;
    return {
      shift: next.shiftId ? ShiftMapper.ref(ctx.shiftsById.get(next.shiftId)) : null,
      effectiveFrom: next.effectiveFrom,
    };
  }

  async assignDepartment(
    me: AuthenticatedUser,
    dto: AssignDepartmentDto,
  ): Promise<DepartmentAssignmentView[]> {
    if (me.role !== Role.SUPER_ADMIN)
      throw new ForbiddenError('Only a Super Admin can set department shifts.');
    const today = this.today();
    this.assertFromToday(dto.effectiveFrom, today);
    const department = dto.department.trim().replace(/\s+/g, ' ');
    const key = departmentKey(department);
    if (!key) throw new ValidationError('Name the department.');
    const requested = dto.companyId ?? null;
    if (requested && !(await this.shifts.companyExists(requested)))
      throw new ValidationError('Unknown company');
    const shift = await this.shiftOrNull(dto.shiftId);
    if (shift?.companyId && requested && shift.companyId !== requested) {
      throw new ValidationError('That shift belongs to another company.');
    }
    // A company's shift only ever applies to that company's department.
    const companyId = requested ?? shift?.companyId ?? null;

    await this.shifts.applyAssignments([
      {
        target: 'DEPARTMENT',
        companyId,
        department,
        departmentKey: key,
        userId: null,
        shiftId: shift?.id ?? null,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo: null,
        createdById: me.id,
      },
    ]);
    this.days.invalidate();
    return this.listDepartments(me);
  }

  // ---- People ---------------------------------------------------------------

  async listPeople(
    me: AuthenticatedUser,
    query: ListPeopleShiftsQueryDto,
  ): Promise<{ items: PersonShiftView[]; meta: PaginationMeta }> {
    this.assertStaffManager(me);
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const filter = {
      managerId: me.role === Role.MANAGER ? me.id : undefined,
      search: query.search?.trim() || undefined,
      department: query.department?.trim() || undefined,
    };
    const [total, people] = await Promise.all([
      this.people.count(filter),
      this.people.findMany({ ...filter, skip: (page - 1) * limit, take: limit }),
    ]);
    const today = this.today();
    const ctx = await this.days.context(people.map((p) => p.id));
    const items = people.map((p) => this.personView(ctx, p, today));
    return { items, meta: buildMeta(total, page, limit) };
  }

  private personView(ctx: ResolutionContext, p: ShiftPerson, today: string): PersonShiftView {
    const resolved = this.days.resolveWith(ctx, p, today);
    const mine = ctx.assignments.filter((a) => a.target === 'USER' && a.userId === p.id);
    const inForceNow = mine.filter((a) => inForce(a, today)).sort(newestFirst)[0];
    const next = mine
      .filter((a) => a.effectiveFrom > today)
      .sort((a, b) =>
        a.effectiveFrom === b.effectiveFrom
          ? newestFirst(a, b)
          : a.effectiveFrom < b.effectiveFrom
            ? -1
            : 1,
      )[0];
    const ref = (id: string | null) => (id ? ShiftMapper.ref(ctx.shiftsById.get(id)) : null);
    return {
      userId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      email: p.email,
      role: p.role,
      department: p.department,
      designation: p.designation,
      managerId: p.managerId,
      shift: ShiftMapper.ref(resolved.shift),
      source: resolved.source,
      override:
        inForceNow?.shiftId && ctx.shiftsById.has(inForceNow.shiftId)
          ? {
              shift: ref(inForceNow.shiftId),
              effectiveFrom: inForceNow.effectiveFrom,
              effectiveTo: inForceNow.effectiveTo,
            }
          : null,
      upcoming: next
        ? {
            shift: ref(next.shiftId),
            effectiveFrom: next.effectiveFrom,
            effectiveTo: next.effectiveTo,
          }
        : null,
    };
  }

  async assignPeople(me: AuthenticatedUser, dto: AssignPeopleDto): Promise<AssignPeopleResult> {
    this.assertStaffManager(me);
    const today = this.today();
    this.assertFromToday(dto.effectiveFrom, today);
    const effectiveTo = dto.effectiveTo ?? null;
    if (effectiveTo && effectiveTo < dto.effectiveFrom) {
      throw new ValidationError('The last day cannot be before the first day.');
    }
    const shift = await this.shiftOrNull(dto.shiftId);
    const ids = [...new Set(dto.userIds)];
    const found = new Map((await this.people.findMany({ ids })).map((p) => [p.id, p]));

    const rows: NewAssignment[] = [];
    const assigned: string[] = [];
    const skipped: AssignPeopleResult['skipped'] = [];
    for (const id of ids) {
      const p = found.get(id);
      if (!p) {
        skipped.push({ id, reason: 'Not found or not active' });
        continue;
      }
      if (me.role === Role.MANAGER && (p.managerId !== me.id || p.role !== 'USER')) {
        skipped.push({ id, reason: 'Not in your team' });
        continue;
      }
      if (shift?.companyId && p.companyId !== shift.companyId) {
        skipped.push({ id, reason: 'That shift belongs to another company' });
        continue;
      }
      rows.push({
        target: 'USER',
        companyId: p.companyId,
        department: null,
        departmentKey: null,
        userId: p.id,
        shiftId: shift?.id ?? null,
        effectiveFrom: dto.effectiveFrom,
        effectiveTo,
        createdById: me.id,
      });
      assigned.push(p.id);
    }
    await this.shifts.applyAssignments(rows);
    this.days.invalidate();
    return { assigned, skipped, effectiveFrom: dto.effectiveFrom, effectiveTo };
  }
}
