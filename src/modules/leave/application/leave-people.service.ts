import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import {
  actingIn,
  allOrgsInView,
  canSeePerson,
  managedDeptIds,
  orgOf,
  seesWholeOrg,
} from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { CalendarService } from '@modules/calendar/application/calendar.service';
import { calendarSource, dayLabel, isWorkingDay } from '@modules/calendar/domain/calendar.rules';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import { LEAVE_REPOSITORY, LeaveRepository } from '../domain/leave.repository';
import { DayInfo } from '../domain/request-rules';
import { Decider, DeciderRole, RoutingPeople } from '../domain/routing';
import { LeavePersonRef } from './leave.views';

/** "Asha Rao" */
export function fullName(
  p: Pick<ShiftPerson, 'firstName' | 'lastName'> | null | undefined,
): string {
  if (!p) return 'Former user';
  return `${p.firstName} ${p.lastName}`.trim() || 'Former user';
}

export interface DayWithShift extends DayInfo {
  shiftStart: string | null;
  shiftEnd: string | null;
  /**
   * 3.5 comp off: a day off set on the organisation calendar is a holiday (its
   * label, else "Holiday"); null for a working day or a weekly day off.
   */
  holiday: string | null;
}

const APPROVER_ROLES: string[] = [Role.SUPER_ADMIN, Role.SUPER_MANAGER, Role.ADMIN, Role.MANAGER];

/** The caller as the routing rules read them. */
export function deciderOf(me: AuthenticatedUser): Decider {
  return { id: me.id, role: me.role, managedDepartmentIds: managedDeptIds(me) };
}

/** The caller acting in the person's organisation (a Super Admin on "All organisations"). */
function inTheirOrg(me: AuthenticatedUser, p: Pick<ShiftPerson, 'companyId'>): AuthenticatedUser {
  return allOrgsInView(me) && p.companyId ? actingIn(me, p.companyId) : me;
}

/**
 * People, scopes and calendars for leave (3.4, on 4.0's tenancy): who the caller
 * may see (their organisation; a Manager the Staff of their departments), names
 * for the views, who is on each approval route, and which days are working days
 * for a person (the organisation calendar, docs/4.0/SPEC.md 2.4).
 */
@Injectable()
export class LeavePeopleService {
  constructor(
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(LEAVE_REPOSITORY) private readonly repo: LeaveRepository,
    private readonly days: BreakDayService,
    private readonly calendar: CalendarService,
  ) {}

  assertOverseer(me: AuthenticatedUser): void {
    if (!APPROVER_ROLES.includes(me.role)) {
      throw new ForbiddenError('Only managers and the organisation admin can see this.');
    }
  }

  /** Anyone, active or not (names in history). */
  async any(ids: string[]): Promise<Map<string, ShiftPerson>> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    return new Map((await this.people.findAnyByIds(unique)).map((p) => [p.id, p] as const));
  }

  async active(id: string): Promise<ShiftPerson | null> {
    return this.people.findById(id);
  }

  /** Whether the caller may see this person (their organisation, departments). */
  canSee(me: AuthenticatedUser, p: ShiftPerson): boolean {
    return canSeePerson(inTheirOrg(me, p), {
      id: p.id,
      role: p.role,
      companyId: p.companyId,
      departmentId: p.departmentId,
    });
  }

  /**
   * Whose leave the caller may see: undefined = every organisation (a Super Admin
   * or the Super Manager on "All organisations" with none asked), else the ids.
   */
  async scopeIds(
    me: AuthenticatedUser,
    q: { companyId?: string; managerId?: string } = {},
  ): Promise<string[] | undefined> {
    this.assertOverseer(me);
    if (allOrgsInView(me) && !q.companyId) return undefined;
    return (await this.scopePeople(me, q)).map((p) => p.id);
  }

  /** The people of a scope (active only), for the balances list. */
  async scopePeople(
    me: AuthenticatedUser,
    q: { companyId?: string; managerId?: string; search?: string } = {},
  ): Promise<ShiftPerson[]> {
    this.assertOverseer(me);
    const companyId = allOrgsInView(me) ? q.companyId : (orgOf(me) ?? undefined);
    if (!companyId && !allOrgsInView(me)) return [];
    const acting = companyId && allOrgsInView(me) ? actingIn(me, companyId) : me;
    if (acting.role === Role.MANAGER) {
      const depts = managedDeptIds(acting);
      if (!depts.length) return [];
      return this.people.findMany({
        companyId,
        departmentIds: depts,
        roles: ['USER'],
        search: q.search,
        take: 1000,
      });
    }
    if (!seesWholeOrg(acting) && !allOrgsInView(me)) return [];
    const roles =
      acting.role === Role.SUPER_MANAGER ? ['USER', 'MANAGER'] : ['USER', 'MANAGER', 'ADMIN'];
    return this.people.findMany({
      ...(companyId ? { companyId } : {}),
      roles: roles as ShiftPerson['role'][],
      ...(q.search ? { search: q.search } : {}),
      take: 1000,
    });
  }

  /** One person the caller may see: themselves, or someone in their scope (404 otherwise). */
  async visible(me: AuthenticatedUser, userId: string): Promise<ShiftPerson> {
    const target = (await this.any([userId])).get(userId);
    if (!target) throw new NotFoundError('Unknown person');
    if (target.id === me.id) return target;
    if (!APPROVER_ROLES.includes(me.role)) {
      throw new ForbiddenError('You can only see your own leave.');
    }
    if (!this.canSee(me, target)) throw new NotFoundError('Unknown person');
    return target;
  }

  async refs(ids: string[]): Promise<Map<string, LeavePersonRef>> {
    const people = await this.any(ids);
    const out = new Map<string, LeavePersonRef>();
    for (const p of people.values()) {
      out.set(p.id, {
        id: p.id,
        name: fullName(p),
        email: p.email,
        role: p.role,
        department: p.department,
        companyId: p.companyId,
        companyName: p.companyName ?? null,
        // 4.0 routes by department, not by a reporting line.
        managerId: null,
        managerName: null,
      });
    }
    return out;
  }

  async routingPeople(person: ShiftPerson): Promise<RoutingPeople> {
    const [departmentManagerIds, adminIds, superManagerIds, superAdminIds] = await Promise.all([
      person.departmentId ? this.people.listDepartmentManagerIds(person.departmentId) : [],
      person.companyId ? this.people.listOrgAdminIds(person.companyId) : [],
      this.repo.activeRoleIds('SUPER_MANAGER'),
      this.people.listSuperAdminIds(),
    ]);
    return { departmentManagerIds, adminIds, superManagerIds, superAdminIds };
  }

  /** Whether each department has an active Manager (who a Manager-route request waits on). */
  async departmentsWithManager(departmentIds: (string | null)[]): Promise<Set<string>> {
    const unique = [...new Set(departmentIds.filter((d): d is string => !!d))];
    const out = new Set<string>();
    await Promise.all(
      unique.map(async (d) => {
        if ((await this.people.listDepartmentManagerIds(d)).length) out.add(d);
      }),
    );
    return out;
  }

  /**
   * "the Billing managers", "the organisation admin", "the Super Manager", "the
   * Super Admins": who decides a pending request now.
   */
  async waitingFor(
    rows: { approverRole: DeciderRole | null; userId: string }[],
  ): Promise<(string | null)[]> {
    const targets = await this.any(rows.map((r) => r.userId));
    const withManager = await this.departmentsWithManager(
      [...targets.values()].map((t) => t.departmentId),
    );
    return rows.map((r) => {
      const t = targets.get(r.userId);
      switch (r.approverRole) {
        case 'MANAGER':
          return t?.departmentId && withManager.has(t.departmentId)
            ? `the ${t.department ?? 'department'} managers`
            : 'the organisation admin';
        case 'ADMIN':
          return 'the organisation admin';
        case 'SUPER_MANAGER':
          return 'the Super Manager';
        case 'SUPER_ADMIN':
          return 'the Super Admins';
        default:
          return null;
      }
    });
  }

  /** The person's first day, as a business day key. */
  async joinDate(userId: string): Promise<string> {
    const at = (await this.repo.joinedAt([userId])).get(userId);
    return dateKeyInZone(at ?? new Date(), appTimezone());
  }

  async joinDates(userIds: string[]): Promise<Map<string, string>> {
    const at = await this.repo.joinedAt(userIds);
    const tz = appTimezone();
    return new Map([...at].map(([id, d]) => [id, dateKeyInZone(d, tz)] as const));
  }

  /**
   * Which of these days are working days for the person (4.0: the organisation
   * calendar decides, with its label for a holiday), with their shift's times.
   */
  async dayInfos(person: ShiftPerson, dates: string[]): Promise<DayWithShift[]> {
    const [ctx, cal] = await Promise.all([
      this.days.context([person.id]),
      this.calendar.forOrg(person.companyId),
    ]);
    return dates.map((date) => {
      const shift = this.days.resolveWith(ctx, person, date).shift;
      const who = { id: person.id, departmentId: person.departmentId };
      const workday = isWorkingDay(cal, date, who);
      const label = dayLabel(cal, date, who);
      const holiday =
        !workday && calendarSource(cal, date, who) === 'OVERRIDE' ? (label ?? 'Holiday') : null;
      return {
        date,
        workday,
        offLabel: workday ? null : (label ?? 'Weekly day off'),
        holiday,
        shiftStart: shift?.start ?? null,
        shiftEnd: shift?.end ?? null,
      };
    });
  }

  /**
   * Whether people work on a date (4.0: their organisation's calendar; 3.5: their
   * own or their department's week first). One calendar read per organisation.
   */
  async workdays(
    people: Pick<ShiftPerson, 'companyId'>[],
  ): Promise<(p: Pick<ShiftPerson, 'id' | 'companyId' | 'departmentId'>, date: string) => boolean> {
    const orgs = [...new Set(people.map((p) => p.companyId ?? ''))];
    const cals = new Map(
      await Promise.all(orgs.map(async (o) => [o, await this.calendar.forOrg(o || null)] as const)),
    );
    return (p, date) =>
      isWorkingDay(cals.get(p.companyId ?? '')!, date, { id: p.id, departmentId: p.departmentId });
  }

  /** The shift times of many people on many days (part-day labels). */
  async shiftTimes(
    items: { person: ShiftPerson; date: string }[],
  ): Promise<Map<string, { start: string; end: string } | null>> {
    const out = new Map<string, { start: string; end: string } | null>();
    if (!items.length) return out;
    const ctx = await this.days.context([...new Set(items.map((i) => i.person.id))]);
    for (const { person, date } of items) {
      const shift = this.days.resolveWith(ctx, person, date).shift;
      out.set(`${person.id}:${date}`, shift ? { start: shift.start, end: shift.end } : null);
    }
    return out;
  }
}
