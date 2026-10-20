import { Inject, Injectable } from '@nestjs/common';
import { ForbiddenError, NotFoundError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { grantsOf, hasAnyGrant, isAdminLike, requireOrg } from '@shared/tenancy';
import { addDaysToKey, appTimezone, dateKeyInZone, hourInZone } from '@shared/utils/timezone';
import { CalendarService } from '@modules/calendar/application/calendar.service';
import { isWorkingDay } from '@modules/calendar/domain/calendar.rules';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { APPROVALS_READER, ApprovalsReader } from '../domain/approvals.reader';
import { Interval, normalize, span, subtract } from '../domain/intervals';
import {
  DepartmentRow,
  LiveFacts,
  PersonRow,
  PresenceRow,
  WORKTIME_READER,
  WorktimeReader,
} from '../domain/worktime.reader';
import { approverScopeOf } from './approver-scope';
import { nameOf, PeopleScopeService } from './people-scope.service';
import { PersonDay, PersonDaysService } from './person-days.service';
import { asShiftPerson } from './team-today.service';

/** An activity sample this recent decides AWAY (idle or locked) while a day is open. */
const AWAY_SAMPLE_MS = 10 * 60_000;
/** Seen this recently: online. */
const ONLINE_MS = 3 * 60_000;
/** Overview and Team answers are reused this long per caller scope. */
const CACHE_MS = 15_000;

export type TeamStatus = 'WORKING' | 'BREAK' | 'MEETING' | 'AWAY' | 'NOT_STARTED' | 'ENDED';

export interface TeamPersonView {
  id: string;
  name: string;
  role: string;
  designation: string | null;
  department: DepartmentRow | null;
  status: TeamStatus;
  since: string | null;
  startedAt: string | null;
  focusSec: number;
  targetSec: number;
  /** Offline time today with no activity data (not in focusSec). */
  unverifiedSec: number;
  /** Payroll time today: focusSec + paidBreakSec. */
  paidSec: number;
  online: boolean;
  agentVersion: string | null;
  lateStartMin: number | null;
}

export interface TeamView {
  date: string;
  counts: {
    all: number;
    active: number;
    working: number;
    onBreak: number;
    inMeeting: number;
    away: number;
    notStarted: number;
    ended: number;
  };
  people: TeamPersonView[];
}

interface Live {
  person: PersonRow;
  day: PersonDay;
  date: string;
  status: TeamStatus;
  since: Date | null;
  online: boolean;
  facts: LiveFacts | undefined;
}

/**
 * Team and Overview (docs/4.0/SPEC.md 5.4, 7.2): one aggregated read per request
 * (no per-person queries), cached briefly per scope. Admin and Super Admin: the
 * organisation; Manager: the Staff of their departments (Team needs at least one
 * grant; Overview's hourly chart needs the activity grant).
 */
@Injectable()
export class TeamOverviewService {
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    @Inject(APPROVALS_READER) private readonly approvals: ApprovalsReader,
    private readonly scope: PeopleScopeService,
    private readonly days: PersonDaysService,
    private readonly breakDays: BreakDayService,
    private readonly calendar: CalendarService,
  ) {}

  private cached<T>(key: string, build: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = build();
    value.catch(() => this.cache.delete(key));
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, { at: now, value });
    return value;
  }

  private scopeKey(me: AuthenticatedUser): string {
    const g = grantsOf(me);
    return [
      requireOrg(me),
      me.role,
      me.role === Role.MANAGER ? [...(me.managedDepartmentIds ?? [])].sort().join(',') : '',
      `${g.screenshots}${g.timeline}${g.activity}`,
    ].join('|');
  }

  /** Everyone in scope with their live status and today's numbers. */
  private async live(
    me: AuthenticatedUser,
    now: Date,
    monthFrom?: string,
  ): Promise<{ lives: Live[]; set: Awaited<ReturnType<PersonDaysService['load']>> }> {
    const tz = appTimezone();
    const calendarDay = dateKeyInZone(now, tz);
    const people = await this.scope.scope(me, {
      fromDate: addDaysToKey(calendarDay, -1),
      toDate: calendarDay,
    });
    const ids = people.map((p) => p.id);
    const [ctx, open, facts] = await Promise.all([
      this.breakDays.context(ids),
      this.reader.presenceOverlapping(ids, now, now),
      this.reader.liveFacts(ids),
    ]);
    // Each person's working day: their shift-day of now (a night shift's early hours
    // belong to the evening before), else the calendar day.
    const dateOf = new Map(
      people.map((p) => [p.id, this.breakDays.dayWith(ctx, asShiftPerson(p), now).dateKey]),
    );
    const dates = [...new Set(dateOf.values()), calendarDay].sort();
    const from = monthFrom && monthFrom < dates[0] ? monthFrom : dates[0];
    const set = await this.days.load(people, from, dates[dates.length - 1], now, { heal: true });
    const openBy = new Map<string, PresenceRow>();
    for (const p of open) if (p.endedAt === null) openBy.set(p.userId, p);

    const lives: Live[] = people.map((person) => {
      const date = dateOf.get(person.id) ?? calendarDay;
      const day = set.day(person, date);
      const f = facts.get(person.id);
      const sessions = day.data.sessions;
      const openSession = sessions.find((s) => s.endedAt === null) ?? null;
      const presence = openBy.get(person.id) ?? null;
      let status: TeamStatus;
      let since: Date | null = null;
      if (openSession) {
        if (presence && (presence.type === 'BREAK' || presence.type === 'LUNCH')) {
          status = 'BREAK';
          since = presence.startedAt;
        } else if (presence && presence.type === 'MEETING') {
          status = 'MEETING';
          since = presence.startedAt;
        } else if (
          f?.lastSampleAt &&
          f.lastSampleIdle &&
          now.getTime() - f.lastSampleAt.getTime() <= AWAY_SAMPLE_MS
        ) {
          status = 'AWAY';
          since = f.lastSampleAt;
        } else {
          status = 'WORKING';
          since = openSession.startedAt;
        }
      } else if (sessions.length) {
        status = 'ENDED';
        since = sessions[sessions.length - 1].endedAt;
      } else {
        status = 'NOT_STARTED';
      }
      const seen = Math.max(f?.lastSeenAt?.getTime() ?? 0, f?.lastSampleAt?.getTime() ?? 0);
      return {
        person,
        day,
        date,
        status,
        since,
        online: seen > 0 && now.getTime() - seen <= ONLINE_MS,
        facts: f,
      };
    });
    return { lives, set };
  }

  async team(
    me: AuthenticatedUser,
    q: { view?: 'active' | 'all'; departmentId?: string; q?: string },
    now: Date,
  ): Promise<TeamView> {
    if (!isAdminLike(me) && !hasAnyGrant(me)) {
      throw new ForbiddenError('Ask your admin for access to Team.', 'GRANT_REQUIRED');
    }
    const companyId = requireOrg(me);
    // A department of another organisation (or, for a Manager, not one of theirs)
    // is unknown, as in reports (re-audit L5).
    if (q.departmentId) {
      const own = await this.reader.departmentsOf(companyId);
      if (
        !own.some((d) => d.id === q.departmentId) ||
        (!isAdminLike(me) && !(me.managedDepartmentIds ?? []).includes(q.departmentId))
      ) {
        throw new NotFoundError('Unknown department');
      }
    }
    const base = await this.cached(`team|${this.scopeKey(me)}`, async () => {
      const [{ lives }, departments] = await Promise.all([
        this.live(me, now),
        this.reader.departmentsOf(companyId),
      ]);
      return { lives, departments };
    });
    const deptBy = new Map(base.departments.map((d) => [d.id, d]));
    const all = base.lives.filter((l) => l.person.active);
    const isActive = (l: Live) =>
      l.status === 'WORKING' ||
      l.status === 'BREAK' ||
      l.status === 'MEETING' ||
      l.status === 'AWAY';
    const counts = {
      all: all.length,
      active: all.filter(isActive).length,
      working: all.filter((l) => l.status === 'WORKING').length,
      onBreak: all.filter((l) => l.status === 'BREAK').length,
      inMeeting: all.filter((l) => l.status === 'MEETING').length,
      away: all.filter((l) => l.status === 'AWAY').length,
      notStarted: all.filter((l) => l.status === 'NOT_STARTED').length,
      ended: all.filter((l) => l.status === 'ENDED').length,
    };
    const words = (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const people = all
      .filter((l) => (q.view === 'active' ? isActive(l) : true))
      .filter((l) => (q.departmentId ? l.person.departmentId === q.departmentId : true))
      .filter((l) => {
        if (!words.length) return true;
        const hay =
          `${nameOf(l.person)} ${l.person.email} ${l.person.designation ?? ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort(
        (a, b) =>
          rank(a.status) - rank(b.status) || nameOf(a.person).localeCompare(nameOf(b.person)),
      )
      .map((l) => this.personView(l, deptBy));
    return { date: dateKeyInZone(now, appTimezone()), counts, people };
  }

  private personView(l: Live, deptBy: Map<string, DepartmentRow>): TeamPersonView {
    const s = l.day.summary;
    return {
      id: l.person.id,
      name: nameOf(l.person),
      role: l.person.role,
      designation: l.person.designation,
      department: l.person.departmentId ? (deptBy.get(l.person.departmentId) ?? null) : null,
      status: l.status,
      since: l.since?.toISOString() ?? null,
      startedAt: s.startedAt,
      focusSec: s.focusSec,
      targetSec: s.targetSec,
      unverifiedSec: s.unverifiedSec,
      paidSec: s.paidSec,
      online: l.online,
      agentVersion: l.facts?.agentVersion ?? null,
      lateStartMin: s.lateStart?.minutes ?? null,
    };
  }

  async overview(me: AuthenticatedUser, now: Date) {
    if (!isAdminLike(me) && me.role !== Role.MANAGER) {
      throw new ForbiddenError('Only managers and admins can see this.');
    }
    const companyId = requireOrg(me);
    return this.cached(`overview|${this.scopeKey(me)}`, () =>
      this.buildOverview(me, companyId, now),
    );
  }

  private async buildOverview(me: AuthenticatedUser, companyId: string, now: Date) {
    const tz = appTimezone();
    const today = dateKeyInZone(now, tz);
    const month = today.slice(0, 7);
    const monthStart = `${month}-01`;
    const scope = approverScopeOf(me, 'all');
    const [{ lives, set }, departments, orgName, adminCount, cal, pending, overdue] =
      await Promise.all([
        this.live(me, now, monthStart),
        this.reader.departmentsOf(companyId),
        this.reader.companyName(companyId),
        isAdminLike(me) ? this.reader.orgAdminCount(companyId) : Promise.resolve(1),
        this.calendar.forOrg(companyId),
        scope ? this.approvals.count({ scope, statuses: ['PENDING'] }) : Promise.resolve(0),
        scope
          ? this.approvals.overdueIn(scope, now)
          : Promise.resolve({ count: 0, oldestDueAt: null }),
      ]);
    const active = lives.filter((l) => l.person.active);
    const visibleDepts = isAdminLike(me)
      ? departments
      : departments.filter((d) => (me.managedDepartmentIds ?? []).includes(d.id));

    // Today
    const todayNums = {
      people: active.length,
      started: active.filter((l) => l.day.data.sessions.length > 0).length,
      working: active.filter((l) => l.status === 'WORKING').length,
      onBreak: active.filter((l) => l.status === 'BREAK').length,
      inMeeting: active.filter((l) => l.status === 'MEETING').length,
      away: active.filter((l) => l.status === 'AWAY').length,
      notStarted: active.filter((l) => l.status === 'NOT_STARTED' && l.day.plan.isWorkingDay)
        .length,
      lateStarts: active.filter((l) => l.day.summary.lateStart).length,
      ended: active.filter((l) => l.status === 'ENDED').length,
      focusSec: sum(active, (l) => l.day.summary.focusSec),
      targetSec: sum(active, (l) => l.day.summary.targetSec),
      unverifiedSec: sum(active, (l) => l.day.summary.unverifiedSec),
      paidSec: sum(active, (l) => l.day.summary.paidSec ?? 0),
    };

    // This month (to today)
    let workingDays = 0;
    let elapsedWorkingDays = 0;
    let mFocus = 0;
    let mTarget = 0;
    let mUnverified = 0;
    let mPaid = 0;
    let full = 0;
    let half = 0;
    let absent = 0;
    const dates: string[] = [];
    for (let d = monthStart; d.startsWith(month); d = addDaysToKey(d, 1)) dates.push(d);
    for (const date of dates) {
      // The calendar of that date (its week pattern from the history, and overrides).
      if (isWorkingDay(cal, date)) {
        workingDays += 1;
        if (date <= today) elapsedWorkingDays += 1;
      }
    }
    for (const l of active) {
      for (const date of dates) {
        if (date > today) break;
        const s = set.day(l.person, date).summary;
        mFocus += s.focusSec;
        mTarget += s.workday ? s.targetSec : 0;
        mUnverified += s.unverifiedSec;
        mPaid += s.paidSec ?? 0;
        if (s.dayClass === 'FULL') full += 1;
        else if (s.dayClass === 'HALF') half += 1;
        else if (s.dayClass === 'ABSENT') absent += 1;
      }
    }

    // Departments grid
    const deptRows = visibleDepts.map((d) => {
      const members = active.filter(
        (l) => l.person.departmentId === d.id && l.person.role === 'USER',
      );
      return {
        id: d.id,
        name: d.name,
        icon: d.icon,
        staff: members.length,
        working: members.filter((l) => l.status === 'WORKING' || l.status === 'MEETING').length,
        focusSec: sum(members, (l) => l.day.summary.focusSec),
        targetSec: sum(members, (l) => l.day.summary.targetSec),
      };
    });

    // Needs attention
    const lite = (ls: Live[]) =>
      ls.slice(0, 20).map((l) => ({ id: l.person.id, name: nameOf(l.person) }));
    const attention: { kind: string; count: number; people: { id: string; name: string }[] }[] = [];
    const add = (kind: string, ls: Live[]) => {
      if (ls.length) attention.push({ kind, count: ls.length, people: lite(ls) });
    };
    if (isAdminLike(me)) {
      if (adminCount === 0) attention.push({ kind: 'NO_ADMIN', count: 1, people: [] });
      add(
        'NO_DEPARTMENT',
        active.filter((l) => l.person.role === 'USER' && !l.person.departmentId),
      );
    }
    add(
      'NO_AGENT',
      active.filter((l) => !l.facts?.agentActivatedAt),
    );
    add(
      'LATE_START',
      active.filter((l) => l.day.summary.lateStart),
    );
    add(
      'AWAY_UNEXPLAINED',
      active.filter((l) => l.day.summary.awayUnexplainedSec > 0),
    );

    // Next holidays (labelled non-working days ahead)
    const nextHolidays = [...cal.overrides.entries()]
      .filter(([date, o]) => date > today && !o.isWorking)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 5)
      .map(([date, o]) => ({ date, label: o.label }));

    // Working people per hour today (needs the activity grant for a Manager)
    const hourly = grantsOf(me).activity ? this.hourly(active, today, now, tz) : undefined;

    return {
      scope: {
        organisation: { id: companyId, name: orgName },
        departments: visibleDepts,
      },
      today: todayNums,
      approvals: {
        pending,
        overdue: overdue.count,
        oldestDueAt: overdue.oldestDueAt?.toISOString() ?? null,
      },
      month: {
        month,
        workingDays,
        elapsedWorkingDays,
        focusSec: mFocus,
        targetSec: mTarget,
        unverifiedSec: mUnverified,
        paidSec: mPaid,
        full,
        half,
        absent,
      },
      departments: deptRows,
      attention,
      nextHolidays,
      ...(hourly ? { hourly } : {}),
      generatedAt: now.toISOString(),
    };
  }

  /** How many people were working (in a session, not on a break) in each hour of today. */
  private hourly(
    lives: Live[],
    today: string,
    now: Date,
    tz: string,
  ): { hour: number; working: number }[] {
    const counts = Array<number>(24).fill(0);
    for (const l of lives) {
      if (l.date !== today) continue;
      const d = l.day.data;
      const work = normalize(d.sessions.map((s) => span(s.startedAt, s.endedAt, now)));
      const breaks = d.presence
        .filter((p) => p.type === 'BREAK' || p.type === 'LUNCH')
        .map((p) => span(p.startedAt, p.endedAt, now));
      const worked: Interval[] = subtract(work, breaks);
      const hours = new Set<number>();
      // 15-minute steps: every hour touched is seen (zones with :30 offsets included).
      for (const i of worked) {
        for (let t = i.start; t < i.end; t += 15 * 60_000) hours.add(hourInZone(new Date(t), tz));
        hours.add(hourInZone(new Date(i.end - 1), tz));
      }
      for (const h of hours) counts[h] += 1;
    }
    const nowHour = hourInZone(now, tz);
    return counts.map((working, hour) => ({ hour, working })).filter((r) => r.hour <= nowHour);
  }
}

function sum<T>(rows: T[], f: (r: T) => number): number {
  return rows.reduce((s, r) => s + f(r), 0);
}

function rank(s: TeamStatus): number {
  return { WORKING: 0, MEETING: 1, AWAY: 2, BREAK: 3, ENDED: 4, NOT_STARTED: 5 }[s];
}
