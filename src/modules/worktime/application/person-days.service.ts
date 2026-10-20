import { Inject, Injectable } from '@nestjs/common';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import { summarizeDay } from '@modules/reports/domain/report-builder';
import { PersonDaySummary } from '@modules/reports/domain/report.types';
import { APPROVALS_READER, ApprovalsReader } from '../domain/approvals.reader';
import { focusOfDay, PersonDayData } from '../domain/day';
import { FocusBreakdown } from '../domain/focus';
import { PersonRow } from '../domain/worktime.reader';
import { DayDataService, DayDataSet } from './day-data.service';
import { DayPlan, DayPlanService, PlanContext } from './day-plan.service';

export type DaysPerson = Pick<PersonRow, 'id' | 'companyId' | 'department' | 'joinedOn'>;

/** One person-day with everything the History, timesheet, Team and Overview show. */
export interface PersonDay {
  data: PersonDayData;
  plan: DayPlan;
  focus: FocusBreakdown;
  summary: PersonDaySummary;
}

/** Days of many people over a date range, loaded with one query per table. */
export class PersonDays {
  constructor(
    private readonly data: DayDataSet,
    readonly plans: PlanContext,
    private readonly pendingBy: Map<string, number>,
    private readonly now: Date,
    private readonly today: string,
  ) {}

  day(p: DaysPerson, date: string): PersonDay {
    const d = this.data.day(p.id, date);
    const plan = this.plans.plan(p, date);
    const focus = focusOfDay(d, this.now, plan.bufferMin);
    const settings = this.plans.settingsOf(p.companyId);
    const summary = summarizeDay({
      date,
      today: this.today,
      data: d,
      focus,
      hourly: [],
      shift: plan.shift,
      shiftStart: plan.shift ? shiftBounds(plan.shift, date, appTimezone()).start : null,
      pending: this.pendingBy.get(`${p.id}|${date}`) ?? 0,
      settings,
      now: this.now,
      joinedOn: p.joinedOn,
      plan: { isWorkingDay: plan.isWorkingDay, label: plan.label, targetSec: plan.targetSec },
    });
    return { data: d, plan, focus, summary };
  }

  /** Open presence of a person (live status), from what was loaded. */
  openPresence(userId: string) {
    return this.data.openPresence(userId);
  }
}

/**
 * The 4.0 per-day engine for many people: work, breaks, meetings, away, the
 * calendar, the allowance and the day class, the same way for the agent's
 * History, the timesheet, Team and Overview (docs/4.0/SPEC.md 2.4, 2.7).
 */
@Injectable()
export class PersonDaysService {
  constructor(
    private readonly dayData: DayDataService,
    private readonly plans: DayPlanService,
    @Inject(APPROVALS_READER) private readonly approvals: ApprovalsReader,
  ) {}

  async load(
    people: DaysPerson[],
    fromDate: string,
    toDate: string,
    now: Date,
    opts: { heal?: boolean } = {},
  ): Promise<PersonDays> {
    const ids = people.map((p) => p.id);
    const [data, pc, pending] = await Promise.all([
      this.dayData.load(ids, fromDate, toDate, now, { heal: opts.heal }),
      this.plans.context(people),
      this.approvals.pendingByUserDate(ids, fromDate, toDate, now),
    ]);
    const pendingBy = new Map(pending.map((r) => [`${r.userId}|${r.date}`, r.pending]));
    return new PersonDays(data, pc, pendingBy, now, dateKeyInZone(now, appTimezone()));
  }
}
