import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { grantsOf, requireOrg, seesWholeOrg } from '@shared/tenancy';
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
import { FocusAdjustmentsService } from '@modules/worktime/application/focus-adjustments.service';
import { PersonDaysService } from '@modules/worktime/application/person-days.service';
import { meetingsOfDay } from '@modules/worktime/domain/day';
import { Timesheet, TimesheetRow } from './report-export';
import { meetingView, MeetingsService } from '@modules/worktime/application/meetings.service';
import { nameOf, PeopleScopeService } from '@modules/worktime/application/people-scope.service';
import { asShiftPerson } from '@modules/worktime/application/team-today.service';
import { APPROVALS_READER, ApprovalsReader } from '@modules/worktime/domain/approvals.reader';
import { BIOMETRIC_SOURCE, focusOfDay, PersonDayData } from '@modules/worktime/domain/day';
import { PUNCHES_READER, PunchesReader } from '@modules/worktime/domain/punches.reader';
import {
  BiometricStretchLite,
  INTEGRATION_PERIODS_READER,
  IntegrationPeriodLite,
  IntegrationPeriodsReader,
} from '@modules/worktime/domain/integration-periods.reader';
import { HourActivity } from '@modules/worktime/domain/hourly';
import { idleOfInput } from '@modules/worktime/domain/input-activity';
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
import {
  inPayroll,
  integrationWasOn,
  isBiometricDay,
  payrollOf,
  payrollPartOf,
} from '../domain/payroll-pause';
import { REPORT_STORE, ReportStore } from '../domain/report.store';
import {
  DayPunchView,
  MonthSnapshot,
  MonthTotals,
  PersonDayReport,
  PersonDaySummary,
  PersonMonthReport,
  PersonPayroll,
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
    avatarId: p.avatarId ?? null,
  };
}

/** A locked month's stored report with the avatar the person has now. */
function withCurrentAvatar(report: PersonMonthReport, p: PersonRow): PersonMonthReport {
  return { ...report, person: { ...report.person, avatarId: p.avatarId ?? null } };
}

/** Everything one month of many people is built from (one query per table). */
interface MonthBuild {
  persons: PersonMonthReport[];
  team: TeamMonthReport;
}

/**
 * What decides the payroll pause (3.6): when each organisation's integration was on (4.0:
 * each runs its own, by organisation id), and who was on biometric before.
 */
interface PauseFacts {
  periods: Map<string, IntegrationPeriodLite[]>;
  stretches: Map<string, BiometricStretchLite[]>;
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
    private readonly adjustments: FocusAdjustmentsService,
    @Inject(PUNCHES_READER) private readonly punches: PunchesReader,
    @Inject(INTEGRATION_PERIODS_READER) private readonly integration: IntegrationPeriodsReader,
  ) {}

  /**
   * A biometric day's punches (3.5), for the day page and the phone's day sheet:
   * read when the person checks in by biometric or the day holds a biometric session.
   */
  private async punchesOf(
    person: { attendanceSource?: 'AGENT' | 'BIOMETRIC' },
    d: PersonDayData,
    day: string,
  ): Promise<DayPunchView[]> {
    const biometric =
      person.attendanceSource === 'BIOMETRIC' ||
      d.sessions.some((s) => s.source === BIOMETRIC_SOURCE);
    if (!biometric) return [];
    const map = await this.punches.punchesOf([d.userId], day, day);
    return (map.get(`${d.userId}|${day}`) ?? []).map((p) => ({
      at: p.at.toISOString(),
      direction: p.direction,
      deviceId: p.deviceId,
      source: p.source,
      voided: p.voided,
    }));
  }

  /**
   * Keyboard and mouse input of one day, inside the time available for it (work
   * sessions minus breaks and meetings), on the rules every screen shares (Fix 10):
   * active, idle (nobody at the computer), and no data (the agent was not reporting).
   */
  private async inputOf(d: PersonDayData, now: Date): Promise<PersonDayReport['input']> {
    try {
      // 3.6: the same read as Team today and the team day, so the figures always agree.
      const b = (await this.dayData.inputOf([d], now)).get(`${d.userId}|${d.date}`);
      return b
        ? {
            activeSec: b.activeSec,
            idleSec: b.idleSec,
            noDataSec: b.noDataSec,
            availableSec: b.spanSec,
          }
        : null;
    } catch {
      return null;
    }
  }

  private today(now: Date): string {
    return dateKeyInZone(now, appTimezone());
  }

  /** The payroll pause's facts for these people: their organisations' switches (3.6). */
  private async pauseFacts(people: PersonRow[]): Promise<PauseFacts> {
    const companyIds = people.map((p) => p.companyId).filter((c): c is string => !!c);
    const [periods, stretches] = await Promise.all([
      this.integration.list(companyIds),
      this.integration.biometricStretches(people.map((p) => p.id)),
    ]);
    return { periods, stretches };
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
      adjustedSec: 0,
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
        adjustedSec: s.adjustedSec ?? 0,
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
      totals.adjustedSec += row.adjustedSec;
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
    const [data, pc, pending, pause] = await Promise.all([
      this.dayData.load([userId], day, day, now, { heal: true }),
      this.plans.context([person]),
      this.approvalsReader.pendingByUserDate([userId], day, day, now),
      this.pauseFacts([person]),
    ]);
    const settings = pc.settingsOf(person.companyId);
    const d = data.day(userId, day);
    const hourly = this.mayActivity(me)
      ? await this.dayData.hourlyFor(d, now, settings.quietHourActiveMin)
      : [];
    const summary = this.summary(person, d, hourly, pc, pending[0]?.pending ?? 0, now, pause);
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
      adjustments: await this.adjustments.views(d.adjustments ?? []),
      input: await this.inputOf(d, now),
      punches: await this.punchesOf(person, d, day),
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
    const [data, pc, buckets, pending, pause] = await Promise.all([
      this.dayData.load(ids, day, day, now, { heal: true }),
      this.plans.context(people),
      activity ? this.dayData.bucketHours(ids, day, day, now) : Promise.resolve(new Map()),
      this.approvalsReader.pendingByUserDate(ids, day, day, now),
      this.pauseFacts(people),
    ]);
    const settings = pc.settingsOf(requireOrg(me));
    const pendingBy = new Map(pending.map((p) => [p.userId, p.pending]));
    // 3.6: idle per person, read in one go like Team today; null when it cannot be read.
    const inputs = await this.dayData
      .inputOf(
        people.map((p) => data.day(p.id, day)),
        now,
      )
      .catch(() => null);
    return {
      date: day,
      rows: people.map((p) => {
        const d = data.day(p.id, day);
        const hourly = activity
          ? this.dayData.bucketHourly(d, buckets, now, settings.quietHourActiveMin)
          : [];
        return {
          person: reportPerson(p),
          summary: {
            ...this.summary(p, d, hourly, pc, pendingBy.get(p.id) ?? 0, now, pause),
            idleSec: inputs ? idleOfInput(inputs.get(`${p.id}|${day}`)) : null,
          },
        };
      }),
    };
  }

  // ---- The person's own (3.4: the mobile app and My dashboard) ---------------------

  private async self(me: AuthenticatedUser): Promise<PersonRow> {
    const [p] = await this.reader.listPeople({ ids: [me.id] });
    if (!p) throw new ValidationError('Unknown person', 'NOT_FOUND');
    return p;
  }

  /**
   * GET /reports/me/month: the person's own month, without the keyboard and mouse
   * figures (SPEC 1.8: those are for managers). A locked month is its snapshot.
   */
  async myMonth(me: AuthenticatedUser, month: string, now: Date): Promise<MyMonthReport> {
    const person = await this.self(me);
    await this.assertMonthInRange(month, now);
    // 4.0: months lock per organisation.
    const snapshot = person.companyId
      ? await this.store.findSnapshot(person.companyId, month)
      : null;
    const fromSnapshot = snapshot?.persons[me.id] ?? snapshot?.payrollPaused?.[me.id];
    const report = fromSnapshot
      ? { ...withPayrollFields(withCurrentAvatar(fromSnapshot, person)), locked: true }
      : { ...(await this.buildMonth([person], month, 'TEAM', now)).persons[0], locked: !!snapshot };
    return {
      person: report.person,
      month: report.month,
      locked: report.locked,
      generatedAt: report.generatedAt,
      totals: ownTotals(report.totals),
      days: report.days.map(ownDay),
      ...(report.payroll
        ? { payroll: { ...report.payroll, totals: ownTotals(report.payroll.totals) } }
        : {}),
    };
  }

  /** GET /reports/me/day: the person's own day (timeline, breaks, meetings, leave), no activity figures. */
  async myDay(me: AuthenticatedUser, date: string | undefined, now: Date): Promise<MyDayReport> {
    const person = await this.self(me);
    const day = date ?? this.today(now);
    // 4.0: the organisation calendar and settings, through the day plan.
    const [data, pc, pending, pause] = await Promise.all([
      this.dayData.load([me.id], day, day, now, { heal: true }),
      this.plans.context([person]),
      this.approvalsReader.pendingByUserDate([me.id], day, day, now),
      this.pauseFacts([person]),
    ]);
    const d = data.day(me.id, day);
    const summary = this.summary(person, d, [], pc, pending[0]?.pending ?? 0, now, pause);
    const shift = pc.plan(asShiftPerson(person), day).shift;
    const names = await this.meetings.names(d.meetingRecords);
    return {
      person: reportPerson(person),
      summary: ownDay(summary),
      shift: ShiftMapper.ref(shift),
      timeline: buildTimeline(d, now),
      breaks: d.breakRecords.map((r) => ShiftMapper.recordView(r, now)),
      meetings: d.meetingRecords.map((m) => meetingView(m, now, names)),
      adjustments: (await this.adjustments.views(d.adjustments ?? [])).filter((a) => !a.voidedAt),
      punches: await this.punchesOf(person, d, day),
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
    const fromSnapshot = snapshot?.persons[userId] ?? snapshot?.payrollPaused?.[userId];
    const activity = this.mayActivity(me);
    if (fromSnapshot) {
      return redactActivity(
        withPayrollFields({ ...withCurrentAvatar(fromSnapshot, person), locked: true }),
        activity,
      );
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
    const scope: 'TEAM' | 'ALL' = seesWholeOrg(me) ? 'ALL' : 'TEAM';
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
        trackedTotals: quiet(built.team.trackedTotals),
        rows: built.team.rows.map((r) => ({
          ...r,
          totals: quiet(r.totals),
          ...(r.payroll ? { payroll: { ...r.payroll, totals: quiet(r.payroll.totals) } } : {}),
        })),
      },
    };
  }

  /** A locked month: the snapshot's rows for these people, totals summed again. */
  private fromSnapshot(
    snapshot: MonthSnapshot,
    people: PersonRow[],
    scope: 'TEAM' | 'ALL',
  ): MonthBuild {
    const persons = people.flatMap((p) => {
      const stored = snapshot.persons[p.id] ?? snapshot.payrollPaused?.[p.id];
      return stored ? [withPayrollFields({ ...withCurrentAvatar(stored, p), locked: true })] : [];
    });
    const rows = persons.map(teamRow);
    // "Today" as it was when the snapshot was taken, so the totals add up the same way.
    const today = dateKeyInZone(new Date(snapshot.generatedAt), appTimezone());
    return {
      persons,
      team: {
        month: snapshot.team.month,
        scope,
        locked: true,
        generatedAt: snapshot.generatedAt,
        ...teamFigures(persons, today),
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
    const [data, pc, buckets, pending, pause, inputs] = await Promise.all([
      this.dayData.load(ids, from, to, now, { heal: true }),
      this.plans.context(people),
      opts.activity === false
        ? Promise.resolve(new Map<string, readonly number[]>())
        : this.dayData.bucketHours(ids, from, to, now),
      this.approvalsReader.pendingByUserDate(ids, from, to, now),
      this.pauseFacts(people),
      // 3.6: the month's idle, read in SQL with settled days kept; null when it cannot be read.
      this.dayData.inputBetween(ids, from, to, now).catch(() => null),
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
        const summary = this.summary(
          p,
          d,
          hourly,
          pc,
          pendingBy.get(`${p.id}|${date}`) ?? 0,
          now,
          pause,
          today,
        );
        days.push(
          d.sessions.length
            ? { ...summary, idleSec: inputs && this.dayData.idleFrom(d, inputs, now) }
            : summary,
        );
        heatmap.push({
          date,
          hours: hourly.length ? hourly.map((h) => h.activeMin) : Array<number>(24).fill(0),
        });
      }
      const payroll = payrollOf(days, today, settings.quietHoursFlag);
      return {
        person: reportPerson(p),
        month,
        locked: false,
        generatedAt,
        totals: monthTotals(days, today, settings.quietHoursFlag),
        days,
        heatmap,
        ...(payroll ? { payroll } : {}),
      };
    });
    const rows = persons.map(teamRow);
    return {
      persons,
      team: {
        month,
        scope,
        locked: false,
        generatedAt,
        ...teamFigures(persons, today),
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
    pause: PauseFacts,
    today: string = this.today(now),
  ): PersonDaySummary {
    const plan = pc.plan(asShiftPerson(p), d.date);
    const settings = pc.settingsOf(p.companyId);
    const shift = plan.shift;
    const bounds = shift ? shiftBounds(shift, d.date, appTimezone()) : null;
    return summarizeDay({
      date: d.date,
      today,
      data: d,
      focus: focusOfDay(d, now, plan.bufferMin),
      hourly,
      shift,
      shiftStart: bounds?.start ?? null,
      shiftEnd: bounds?.end ?? null,
      pending,
      settings,
      now,
      joinedOn: p.joinedOn,
      plan: { isWorkingDay: plan.isWorkingDay, label: plan.label, targetSec: plan.targetSec },
      // 3.6: biometric staff while their organisation's integration is off (4.0: each
      // organisation's own switch; another organisation's never counts).
      payrollPaused:
        isBiometricDay(p, d.date, d.sessions, pause.stretches.get(p.id)) &&
        !integrationWasOn((p.companyId && pause.periods.get(p.companyId)) || [], d.date),
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
    ...(p.payroll
      ? {
          payroll: {
            ...p.payroll,
            totals: { ...p.payroll.totals, quietHours: 0, needsALook: false },
          },
        }
      : {}),
  };
}

/**
 * A team's two sets of totals (3.6): what payroll counts, and everything as tracked, paused
 * days and people included (only payroll changes for them).
 */
function teamFigures(
  persons: PersonMonthReport[],
  today: string,
): Pick<TeamMonthReport, 'totals' | 'trackedTotals'> {
  return {
    totals: teamTotals(inPayroll(persons).map(payrollPartOf), today),
    trackedTotals: teamTotals(
      persons.map((p) => ({ totals: p.totals, days: p.days })),
      today,
    ),
  };
}

/** One person's row in a team month. */
function teamRow(p: PersonMonthReport): TeamMonthReport['rows'][number] {
  return {
    person: p.person,
    totals: p.totals,
    days: p.days.map((d) => ({ date: d.date, dayClass: d.dayClass, focusSec: d.focusSec })),
    ...(p.payroll ? { payroll: p.payroll } : {}),
  };
}

/** A day as its owner sees it: no keyboard and mouse figures (SPEC 1.8). */
export type OwnDaySummary = Omit<
  PersonDaySummary,
  'quietHours' | 'activeMin' | 'activeSec' | 'availableSec' | 'idleSec'
>;
export type OwnMonthTotals = Omit<
  MonthTotals,
  'quietHours' | 'activeSec' | 'availableSec' | 'needsALook' | 'idleSec'
>;

export function ownDay(d: PersonDaySummary): OwnDaySummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { quietHours, activeMin, activeSec, availableSec, idleSec, ...rest } = d;
  return rest;
}

export function ownTotals(t: MonthTotals): OwnMonthTotals {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { quietHours, activeSec, availableSec, needsALook, idleSec, ...rest } = t;
  return rest;
}

export interface MyMonthReport {
  person: ReportPerson;
  month: string;
  locked: boolean;
  generatedAt: string;
  totals: OwnMonthTotals;
  days: OwnDaySummary[];
  /** 3.6: set when some day of the month is paused (biometric staff). */
  payroll?: Omit<PersonPayroll, 'totals'> & { totals: OwnMonthTotals };
}

export interface MyDayReport {
  person: ReportPerson;
  summary: OwnDaySummary;
  shift: PersonDayReport['shift'];
  timeline: PersonDayReport['timeline'];
  breaks: PersonDayReport['breaks'];
  meetings: PersonDayReport['meetings'];
  adjustments: NonNullable<PersonDayReport['adjustments']>;
  /** The day's punches (3.5), a biometric person; [] otherwise. */
  punches: NonNullable<PersonDayReport['punches']>;
}
