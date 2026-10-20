import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { grantsOf, isAdminLike, requireOrg } from '@shared/tenancy';
import { addDaysToKey, appTimezone, dateKeyInZone, time12InZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { ShiftMapper } from '@modules/shifts/application/shift.mapper';
import { outcomeOf } from '@modules/shifts/domain/break-record.repository';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import { BREAK_LABEL, BreakKind, isScheduledKind } from '@modules/shifts/domain/shift.types';
import { ApprovalsService } from '@modules/worktime/application/approvals.service';
import { DayDataService } from '@modules/worktime/application/day-data.service';
import { DayPlanService, PlanContext } from '@modules/worktime/application/day-plan.service';
import { PersonDaysService } from '@modules/worktime/application/person-days.service';
import { meetingsOfDay } from '@modules/worktime/domain/day';
import { Timesheet, TimesheetRow } from './report-export';
import { meetingView, MeetingsService } from '@modules/worktime/application/meetings.service';
import { nameOf, PeopleScopeService } from '@modules/worktime/application/people-scope.service';
import { asShiftPerson } from '@modules/worktime/application/team-today.service';
import { APPROVALS_READER, ApprovalsReader } from '@modules/worktime/domain/approvals.reader';
import { focusOfDay, PersonDayData } from '@modules/worktime/domain/day';
import { HourActivity } from '@modules/worktime/domain/hourly';
import {
  PersonRow,
  WORKTIME_READER,
  WorktimeReader,
} from '@modules/worktime/domain/worktime.reader';
import {
  buildTimeline,
  monthDates,
  monthRangeProblem,
  monthTotals,
  summarizeDay,
  teamTotals,
  withPayrollFields,
} from '../domain/report-builder';
import { REPORT_STORE, ReportStore } from '../domain/report.store';
import {
  MonthSnapshot,
  PersonDayReport,
  PersonDaySummary,
  PersonMonthReport,
  ReportPerson,
  TeamDayReport,
  TeamMonthReport,
} from '../domain/report.types';

export function reportPerson(p: PersonRow): ReportPerson {
  return {
    id: p.id,
    name: nameOf(p),
    email: p.email,
    role: p.role,
    department: p.department,
    designation: p.designation,
    departmentId: p.departmentId ?? null,
    managerId: p.managerId,
    managerName: p.managerName,
  };
}

/** Everything one month of many people is built from (one query per table). */
interface MonthBuild {
  persons: PersonMonthReport[];
  team: TeamMonthReport;
}

/**
 * Reports (SPEC 1.9, 3.7): person-day, person-month, team-day and team-month,
 * scoped like Team today. A locked month is read from its snapshot.
 */
@Injectable()
export class ReportsService {
  constructor(
    @Inject(REPORT_STORE) private readonly store: ReportStore,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    @Inject(APPROVALS_READER) private readonly approvalsReader: ApprovalsReader,
    private readonly scope: PeopleScopeService,
    private readonly dayData: DayDataService,
    private readonly approvals: ApprovalsService,
    private readonly meetings: MeetingsService,
    private readonly days: BreakDayService,
    private readonly settings: AppSettingsService,
    private readonly plans: DayPlanService,
    private readonly personDays: PersonDaysService,
  ) {}

  private today(now: Date): string {
    return dateKeyInZone(now, appTimezone());
  }

  /** The month asked for, or the current one in business time. */
  monthOrCurrent(month: string | undefined, now: Date): string {
    return month ?? this.today(now).slice(0, 7);
  }

  /** Why a month cannot be reported (future, or before the first work session), else null. */
  async monthProblem(month: string, now: Date): Promise<string | null> {
    return monthRangeProblem(
      month,
      this.today(now).slice(0, 7),
      await this.reader.earliestSessionDate(),
    );
  }

  /** 400 for a future month or one before the first work session (SPEC 3.7). */
  async assertMonthInRange(month: string, now: Date): Promise<void> {
    const problem = await this.monthProblem(month, now);
    if (problem)
      throw new ValidationError(problem, 'VALIDATION_ERROR').withDetails({ field: 'month' });
  }

  async people(me: AuthenticatedUser, now: Date): Promise<{ items: ReportPerson[] }> {
    const people = await this.scope.scope(me, { fromDate: '0000-01-01', toDate: this.today(now) });
    return { items: people.map(reportPerson) };
  }

  // ---- Timesheet (4.0, docs/4.0/SPEC.md 5.8) -------------------------------------

  /**
   * One person's days in a range (at most 366), one row per day from the focus
   * engine: in and out (ISO and 12-hour), focus against target, paid and unpaid
   * breaks, meetings, away time and the day class. One request, one query per table.
   */
  async timesheet(
    me: AuthenticatedUser,
    userId: string,
    from: string,
    to: string,
    now: Date,
  ): Promise<Timesheet> {
    const person = await this.scope.person(me, userId);
    if (to < from)
      throw new ValidationError('"to" must not be before "from".').withDetails({ field: 'to' });
    const span =
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) +
      1;
    if (span > 366) {
      throw new ValidationError('A timesheet covers at most 366 days.').withDetails({
        field: 'to',
      });
    }
    const today = this.today(now);
    const last = to > today ? today : to;
    const tz = appTimezone();
    const set = await this.personDays.load([person], from, last < from ? from : last, now, {
      heal: true,
    });
    const rows: TimesheetRow[] = [];
    const totals: Timesheet['totals'] = {
      days: 0,
      workingDays: 0,
      full: 0,
      half: 0,
      absent: 0,
      focusSec: 0,
      targetSec: 0,
      breakSec: 0,
      paidBreakSec: 0,
      unpaidBreakSec: 0,
      meetingsSec: 0,
      awayApprovedSec: 0,
      awayPendingSec: 0,
      unverifiedSec: 0,
      paidSec: 0,
    };
    for (let date = from; date <= to; date = addDaysToKey(date, 1)) {
      const day = set.day(person, date);
      const s = day.summary;
      const meetingsSec = meetingsOfDay(day.data, now).sec;
      const row: TimesheetRow = {
        date,
        weekday: s.weekday,
        isWorkingDay: s.workday,
        label: day.plan.label,
        in: s.startedAt,
        out: s.endedAt,
        in12: s.startedAt ? time12InZone(new Date(s.startedAt), tz) : null,
        out12: s.endedAt ? time12InZone(new Date(s.endedAt), tz) : null,
        focusSec: s.focusSec,
        targetSec: s.workday ? s.targetSec : 0,
        breakSec: s.breakSec,
        paidBreakSec: s.paidBreakSec,
        unpaidBreakSec: s.unpaidBreakSec,
        meetingsSec,
        awayApprovedSec: s.awayApprovedSec,
        awayPendingSec: s.awayPendingSec,
        unverifiedSec: s.unverifiedSec,
        paidSec: s.paidSec,
        status: s.dayClass,
      };
      rows.push(row);
      totals.days += 1;
      if (row.isWorkingDay) totals.workingDays += 1;
      if (s.dayClass === 'FULL') totals.full += 1;
      if (s.dayClass === 'HALF') totals.half += 1;
      if (s.dayClass === 'ABSENT') totals.absent += 1;
      totals.focusSec += row.focusSec;
      totals.targetSec += row.targetSec;
      totals.breakSec += row.breakSec;
      totals.paidBreakSec += row.paidBreakSec;
      totals.unpaidBreakSec += row.unpaidBreakSec;
      totals.meetingsSec += row.meetingsSec;
      totals.awayApprovedSec += row.awayApprovedSec;
      totals.awayPendingSec += row.awayPendingSec;
      totals.unverifiedSec += row.unverifiedSec;
      totals.paidSec += row.paidSec;
    }
    return {
      person: {
        id: person.id,
        name: nameOf(person),
        email: person.email,
        department: person.department,
        designation: person.designation,
      },
      range: { from, to },
      rows,
      totals,
    };
  }

  // ---- One day ------------------------------------------------------------------

  async personDay(
    me: AuthenticatedUser,
    userId: string,
    date: string | undefined,
    now: Date,
  ): Promise<PersonDayReport> {
    const person = await this.scope.person(me, userId);
    const day = date ?? this.today(now);
    const [data, pc, pending] = await Promise.all([
      this.dayData.load([userId], day, day, now, { heal: true }),
      this.plans.context([person]),
      this.approvalsReader.pendingByUserDate([userId], day, day, now),
    ]);
    const settings = pc.settingsOf(person.companyId);
    const d = data.day(userId, day);
    const hourly = this.mayActivity(me)
      ? await this.dayData.hourlyFor(d, now, settings.quietHourActiveMin)
      : [];
    const summary = this.summary(person, d, hourly, pc, pending[0]?.pending ?? 0, now);
    const shift = pc.plan(person, day).shift;
    const names = await this.meetings.names(d.meetingRecords);
    return {
      person: reportPerson(person),
      summary,
      shift: ShiftMapper.ref(shift),
      // The presence timeline (work and break spans) is timeline data, as on
      // /presence/team/:id/timeline (re-audit L4); totals, breaks and meetings stay.
      timeline: grantsOf(me).timeline ? buildTimeline(d, now) : [],
      skips: d.breakRecords
        .filter((r) => isScheduledKind(r.kind) && outcomeOf(r) !== 'TAKEN')
        .map((r) => ({
          at: r.startedAt.toISOString(),
          kind: r.kind as BreakKind,
          label: BREAK_LABEL[r.kind as BreakKind],
          outcome: outcomeOf(r) as 'SKIPPED' | 'AUTO_SKIPPED',
        })),
      breaks: d.breakRecords.map((r) => ShiftMapper.recordView(r, now)),
      meetings: d.meetingRecords.map((m) => meetingView(m, now, names)),
      approvals: await this.approvals.itemsFor(me, [userId], day, day, now),
      hourly,
    };
  }

  async teamDay(
    me: AuthenticatedUser,
    date: string | undefined,
    userIds: string[] | undefined,
    now: Date,
    departmentId?: string,
  ): Promise<TeamDayReport> {
    const day = date ?? this.today(now);
    const people = await this.scope.scope(me, {
      userIds,
      departmentId,
      fromDate: day,
      toDate: day,
    });
    const ids = people.map((p) => p.id);
    const activity = this.mayActivity(me);
    const [data, pc, buckets, pending] = await Promise.all([
      this.dayData.load(ids, day, day, now, { heal: true }),
      this.plans.context(people),
      activity ? this.dayData.bucketHours(ids, day, day, now) : Promise.resolve(new Map()),
      this.approvalsReader.pendingByUserDate(ids, day, day, now),
    ]);
    const settings = pc.settingsOf(requireOrg(me));
    const pendingBy = new Map(pending.map((p) => [p.userId, p.pending]));
    return {
      date: day,
      rows: people.map((p) => {
        const d = data.day(p.id, day);
        const hourly = activity
          ? this.dayData.bucketHourly(d, buckets, now, settings.quietHourActiveMin)
          : [];
        return {
          person: reportPerson(p),
          summary: this.summary(p, d, hourly, pc, pendingBy.get(p.id) ?? 0, now),
        };
      }),
    };
  }

  // ---- One month ----------------------------------------------------------------

  async personMonth(
    me: AuthenticatedUser,
    userId: string,
    month: string,
    now: Date,
  ): Promise<PersonMonthReport> {
    const person = await this.scope.person(me, userId);
    await this.assertMonthInRange(month, now);
    const snapshot = await this.store.findSnapshot(requireOrg(me), month);
    const fromSnapshot = snapshot?.persons[userId];
    const activity = this.mayActivity(me);
    if (fromSnapshot) {
      return redactActivity(withPayrollFields({ ...fromSnapshot, locked: true }), activity);
    }
    const built = await this.buildMonth([person], month, 'TEAM', now, { activity });
    return redactActivity({ ...built.persons[0], locked: !!snapshot }, activity);
  }

  async teamMonth(
    me: AuthenticatedUser,
    month: string,
    managerId: string | undefined,
    userIds: string[] | undefined,
    now: Date,
    departmentId?: string,
  ): Promise<TeamMonthReport> {
    const { team } = await this.teamMonthWithPersons(
      me,
      month,
      managerId,
      userIds,
      now,
      departmentId,
    );
    return team;
  }

  /** The team-month report with each person's full month (exports need both). */
  async teamMonthWithPersons(
    me: AuthenticatedUser,
    month: string,
    managerId: string | undefined,
    userIds: string[] | undefined,
    now: Date,
    departmentId?: string,
  ): Promise<MonthBuild> {
    await this.assertMonthInRange(month, now);
    const dates = monthDates(month);
    const people = await this.scope.scope(me, {
      managerId,
      userIds,
      departmentId,
      fromDate: dates[0],
      toDate: dates[dates.length - 1],
    });
    const scope: 'TEAM' | 'ALL' = isAdminLike(me) ? 'ALL' : 'TEAM';
    const snapshot = await this.store.findSnapshot(requireOrg(me), month);
    const activity = this.mayActivity(me);
    const built = snapshot
      ? this.fromSnapshot(snapshot, people, scope)
      : await this.buildMonth(people, month, scope, now, { activity });
    if (activity) return built;
    // Quiet hours are activity data: every row's totals too (re-audit M4).
    const quiet = <T extends { quietHours: number; needsALook: boolean }>(t: T): T => ({
      ...t,
      quietHours: 0,
      needsALook: false,
    });
    return {
      persons: built.persons.map((p) => redactActivity(p, false)),
      team: {
        ...built.team,
        totals: quiet(built.team.totals),
        rows: built.team.rows.map((r) => ({ ...r, totals: quiet(r.totals) })),
      },
    };
  }

  /** A locked month: the snapshot's rows for these people, totals summed again. */
  private fromSnapshot(
    snapshot: MonthSnapshot,
    people: PersonRow[],
    scope: 'TEAM' | 'ALL',
  ): MonthBuild {
    const persons = people
      .map((p) => snapshot.persons[p.id])
      .filter((x): x is PersonMonthReport => !!x)
      .map((p) => withPayrollFields({ ...p, locked: true }));
    const rows = persons.map((p) => ({
      person: p.person,
      totals: p.totals,
      days: p.days.map((d) => ({ date: d.date, dayClass: d.dayClass, focusSec: d.focusSec })),
    }));
    // "Today" as it was when the snapshot was taken, so the totals add up the same way.
    const today = dateKeyInZone(new Date(snapshot.generatedAt), appTimezone());
    return {
      persons,
      team: {
        month: snapshot.team.month,
        scope,
        locked: true,
        generatedAt: snapshot.generatedAt,
        totals: teamTotals(
          persons.map((p) => ({ totals: p.totals, days: p.days })),
          today,
        ),
        rows,
      },
    };
  }

  /** Builds a month for these people from live data. */
  async buildMonth(
    people: PersonRow[],
    month: string,
    scope: 'TEAM' | 'ALL',
    now: Date,
    opts: { activity?: boolean } = {},
  ): Promise<MonthBuild> {
    const dates = monthDates(month);
    const from = dates[0];
    const to = dates[dates.length - 1];
    const today = this.today(now);
    const ids = people.map((p) => p.id);
    const [data, pc, buckets, pending] = await Promise.all([
      this.dayData.load(ids, from, to, now, { heal: true }),
      this.plans.context(people),
      opts.activity === false
        ? Promise.resolve(new Map<string, readonly number[]>())
        : this.dayData.bucketHours(ids, from, to, now),
      this.approvalsReader.pendingByUserDate(ids, from, to, now),
    ]);
    const settings = pc.settingsOf(people[0]?.companyId ?? null);
    const pendingBy = new Map(pending.map((p) => [`${p.userId}|${p.date}`, p.pending]));
    const generatedAt = now.toISOString();

    const persons: PersonMonthReport[] = people.map((p) => {
      const days: PersonDaySummary[] = [];
      const heatmap: { date: string; hours: number[] }[] = [];
      for (const date of dates) {
        const d = data.day(p.id, date);
        // Without the activity grant there are no buckets: no hourly activity at all
        // (never quiet hours made up from empty buckets).
        const hourly =
          date <= today && opts.activity !== false
            ? this.dayData.bucketHourly(d, buckets, now, settings.quietHourActiveMin)
            : [];
        days.push(
          this.summary(p, d, hourly, pc, pendingBy.get(`${p.id}|${date}`) ?? 0, now, today),
        );
        heatmap.push({
          date,
          hours: hourly.length ? hourly.map((h) => h.activeMin) : Array<number>(24).fill(0),
        });
      }
      return {
        person: reportPerson(p),
        month,
        locked: false,
        generatedAt,
        totals: monthTotals(days, today, settings.quietHoursFlag),
        days,
        heatmap,
      };
    });
    const rows = persons.map((p) => ({
      person: p.person,
      totals: p.totals,
      days: p.days.map((d) => ({ date: d.date, dayClass: d.dayClass, focusSec: d.focusSec })),
    }));
    return {
      persons,
      team: {
        month,
        scope,
        locked: false,
        generatedAt,
        totals: teamTotals(
          persons.map((p) => ({ totals: p.totals, days: p.days })),
          today,
        ),
        rows,
      },
    };
  }

  private summary(
    p: PersonRow,
    d: PersonDayData,
    hourly: HourActivity[],
    pc: PlanContext,
    pending: number,
    now: Date,
    today: string = this.today(now),
  ): PersonDaySummary {
    const plan = pc.plan(asShiftPerson(p), d.date);
    const settings = pc.settingsOf(p.companyId);
    const shift = plan.shift;
    return summarizeDay({
      date: d.date,
      today,
      data: d,
      focus: focusOfDay(d, now, plan.bufferMin),
      hourly,
      shift,
      shiftStart: shift ? shiftBounds(shift, d.date, appTimezone()).start : null,
      pending,
      settings,
      now,
      joinedOn: p.joinedOn,
      plan: { isWorkingDay: plan.isWorkingDay, label: plan.label, targetSec: plan.targetSec },
    });
  }

  /** Hourly activity and quiet hours: admins, and managers with the activity grant (4.0). */
  private mayActivity(me: AuthenticatedUser): boolean {
    return grantsOf(me).activity;
  }
}

/** A person-month without hourly activity (a Manager without the activity grant, 4.0). */
function redactActivity(p: PersonMonthReport, activity: boolean): PersonMonthReport {
  if (activity) return p;
  return {
    ...p,
    heatmap: [],
    days: p.days.map((d) => ({ ...d, quietHours: 0, activeMin: 0 })),
    totals: { ...p.totals, quietHours: 0, needsALook: false },
  };
}
