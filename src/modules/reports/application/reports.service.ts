import { Inject, Injectable } from '@nestjs/common';
import { ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService, ResolutionContext } from '@modules/shifts/application/break-day.service';
import { ShiftMapper } from '@modules/shifts/application/shift.mapper';
import { outcomeOf } from '@modules/shifts/domain/break-record.repository';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import { BREAK_LABEL } from '@modules/shifts/domain/shift.types';
import { ApprovalsService } from '@modules/worktime/application/approvals.service';
import { DayDataService } from '@modules/worktime/application/day-data.service';
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
import { AppSettings } from '@modules/settings/domain/settings.rules';
import {
  buildTimeline,
  monthDates,
  monthRangeProblem,
  monthTotals,
  summarizeDay,
  teamTotals,
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
  ) {}

  private today(now: Date): string {
    return dateKeyInZone(now, appTimezone());
  }

  /** The month asked for, or the current one in business time. */
  monthOrCurrent(month: string | undefined, now: Date): string {
    return month ?? this.today(now).slice(0, 7);
  }

  /** 400 for a future month or one before the first work session (SPEC 3.7). */
  async assertMonthInRange(month: string, now: Date): Promise<void> {
    const problem = monthRangeProblem(
      month,
      this.today(now).slice(0, 7),
      await this.reader.earliestSessionDate(),
    );
    if (problem)
      throw new ValidationError(problem, 'VALIDATION_ERROR').withDetails({ field: 'month' });
  }

  async people(me: AuthenticatedUser, now: Date): Promise<{ items: ReportPerson[] }> {
    const people = await this.scope.scope(me, { fromDate: '0000-01-01', toDate: this.today(now) });
    return { items: people.map(reportPerson) };
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
    const [data, ctx, settings, pending] = await Promise.all([
      this.dayData.load([userId], day, day, now, { heal: true }),
      this.days.context([userId]),
      this.settings.get(),
      this.approvalsReader.pendingByUserDate([userId], day, day, now),
    ]);
    const d = data.day(userId, day);
    const hourly = await this.dayData.hourlyFor(d, now, settings.quietHourActiveMin);
    const summary = this.summary(person, d, hourly, ctx, settings, pending[0]?.pending ?? 0, now);
    const shift = this.days.resolveWith(ctx, asShiftPerson(person), day).shift;
    const names = await this.meetings.names(d.meetingRecords);
    return {
      person: reportPerson(person),
      summary,
      shift: ShiftMapper.ref(shift),
      timeline: buildTimeline(d, now),
      skips: d.breakRecords
        .filter((r) => r.kind && outcomeOf(r) !== 'TAKEN')
        .map((r) => ({
          at: r.startedAt.toISOString(),
          kind: r.kind!,
          label: BREAK_LABEL[r.kind!],
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
  ): Promise<TeamDayReport> {
    const day = date ?? this.today(now);
    const people = await this.scope.scope(me, { userIds, fromDate: day, toDate: day });
    const ids = people.map((p) => p.id);
    const [data, ctx, settings, buckets, pending] = await Promise.all([
      this.dayData.load(ids, day, day, now, { heal: true }),
      this.days.context(ids),
      this.settings.get(),
      this.dayData.bucketHours(ids, day, day, now),
      this.approvalsReader.pendingByUserDate(ids, day, day, now),
    ]);
    const pendingBy = new Map(pending.map((p) => [p.userId, p.pending]));
    return {
      date: day,
      rows: people.map((p) => {
        const d = data.day(p.id, day);
        const hourly = this.dayData.bucketHourly(d, buckets, now, settings.quietHourActiveMin);
        return {
          person: reportPerson(p),
          summary: this.summary(p, d, hourly, ctx, settings, pendingBy.get(p.id) ?? 0, now),
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
    const snapshot = await this.store.findSnapshot(month);
    const fromSnapshot = snapshot?.persons[userId];
    if (fromSnapshot) return { ...fromSnapshot, locked: true };
    const built = await this.buildMonth([person], month, 'TEAM', now);
    return { ...built.persons[0], locked: !!snapshot };
  }

  async teamMonth(
    me: AuthenticatedUser,
    month: string,
    managerId: string | undefined,
    userIds: string[] | undefined,
    now: Date,
  ): Promise<TeamMonthReport> {
    const { team } = await this.teamMonthWithPersons(me, month, managerId, userIds, now);
    return team;
  }

  /** The team-month report with each person's full month (exports need both). */
  async teamMonthWithPersons(
    me: AuthenticatedUser,
    month: string,
    managerId: string | undefined,
    userIds: string[] | undefined,
    now: Date,
  ): Promise<MonthBuild> {
    await this.assertMonthInRange(month, now);
    const dates = monthDates(month);
    const people = await this.scope.scope(me, {
      managerId,
      userIds,
      fromDate: dates[0],
      toDate: dates[dates.length - 1],
    });
    const scope: 'TEAM' | 'ALL' = me.role === Role.SUPER_ADMIN && !managerId ? 'ALL' : 'TEAM';
    const snapshot = await this.store.findSnapshot(month);
    if (snapshot) return this.fromSnapshot(snapshot, people, scope);
    return this.buildMonth(people, month, scope, now);
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
      .map((p) => ({ ...p, locked: true }));
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
  ): Promise<MonthBuild> {
    const dates = monthDates(month);
    const from = dates[0];
    const to = dates[dates.length - 1];
    const today = this.today(now);
    const ids = people.map((p) => p.id);
    const [data, ctx, settings, buckets, pending] = await Promise.all([
      this.dayData.load(ids, from, to, now, { heal: true }),
      this.days.context(ids),
      this.settings.get(),
      this.dayData.bucketHours(ids, from, to, now),
      this.approvalsReader.pendingByUserDate(ids, from, to, now),
    ]);
    const pendingBy = new Map(pending.map((p) => [`${p.userId}|${p.date}`, p.pending]));
    const generatedAt = now.toISOString();

    const persons: PersonMonthReport[] = people.map((p) => {
      const days: PersonDaySummary[] = [];
      const heatmap: { date: string; hours: number[] }[] = [];
      for (const date of dates) {
        const d = data.day(p.id, date);
        const hourly =
          date <= today
            ? this.dayData.bucketHourly(d, buckets, now, settings.quietHourActiveMin)
            : [];
        days.push(
          this.summary(
            p,
            d,
            hourly,
            ctx,
            settings,
            pendingBy.get(`${p.id}|${date}`) ?? 0,
            now,
            today,
          ),
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
    ctx: ResolutionContext,
    settings: AppSettings,
    pending: number,
    now: Date,
    today: string = this.today(now),
  ): PersonDaySummary {
    const shift = this.days.resolveWith(ctx, asShiftPerson(p), d.date).shift;
    return summarizeDay({
      date: d.date,
      today,
      data: d,
      focus: focusOfDay(d, now),
      hourly,
      shift,
      shiftStart: shift ? shiftBounds(shift, d.date, appTimezone()).start : null,
      pending,
      settings,
      now,
      joinedOn: p.joinedOn,
    });
  }
}
