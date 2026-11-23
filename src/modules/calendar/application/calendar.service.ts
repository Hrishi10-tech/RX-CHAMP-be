import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { monthLockedError } from '@shared/database/month-lock';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import { NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import {
  checkWeekPattern,
  cleanLabel,
  DayOverride,
  isValidDateKey,
  isWorkingDay,
  dayLabel,
  monthSummary,
  OrgCalendar,
  patternHistoryFromStored,
  patternOn,
  PATTERN_SINCE_ALWAYS,
  WeekPatternEntry,
  withPatternFrom,
  DEFAULT_WEEK_PATTERN,
  MonthSummary,
  calendarSource,
  CalendarSource,
  CalendarWho,
  CALENDAR_SOURCE_LABEL,
  datesOfMonth,
  isSaturdayRule,
  SaturdayRule,
  SATURDAY_RULE_LABEL,
  WorkWeek,
} from '../domain/calendar.rules';

/** Published on every calendar change (3.4: leave on a day that stops being worked is given back). */
export const CALENDAR_CHANGED = 'calendar.changed';

export interface WorkWeekView extends WorkWeek {
  /** The department's or the person's id. */
  id: string;
  saturdaysLabel: string;
}

export interface PersonYearView {
  userId: string;
  year: number;
  /** What decides most of their days, in words. */
  source: CalendarSource;
  sourceLabel: string;
  workingDays: number;
  days: { date: string; working: boolean; label: string | null; source: CalendarSource }[];
}

const CACHE_MS = 30_000;

export interface CalendarView {
  year: number;
  /** 3.5: the organisation's Saturday rule (EVERY: every Saturday of the pattern). */
  saturdays: SaturdayRule;
  saturdayAnchor: string | null;
  saturdaysLabel: string;
  /** 3.5: departments and people with their own week. */
  departments: WorkWeekView[];
  people: WorkWeekView[];
  /** The week pattern in force today. */
  weekPattern: number[];
  /** Every pattern and the date it applies from, oldest first (the first: since always). */
  weekPatternHistory: WeekPatternEntry[];
  overrides: { date: string; isWorking: boolean; label: string | null; departmentIds: string[] }[];
  months: MonthSummary[];
}

/**
 * Organisation calendars (docs/4.0/SPEC.md 2.6, 5.5): the week pattern history in
 * the organisation settings row and per-date overrides in calendar_days, read
 * through a short cache (every day class and target needs them). Writes clear
 * the cache and tell the organisation's agents (`config:changed` CALENDAR).
 * Changing a day in a month locked for payroll is refused (409 MONTH_LOCKED), and
 * so is a week pattern effective from a date in or before a locked month.
 */
@Injectable()
export class CalendarService {
  private readonly cache = new Map<string, { cal: OrgCalendar; at: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AppSettingsService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  /** The organisation's calendar (no organisation: the default pattern, no overrides). */
  async forOrg(companyId: string | null | undefined): Promise<OrgCalendar> {
    if (!companyId) return { weekPattern: [...DEFAULT_WEEK_PATTERN], overrides: new Map() };
    const now = Date.now();
    const hit = this.cache.get(companyId);
    if (hit && now - hit.at < CACHE_MS) return hit.cal;
    const [raw, rows, weeks] = await Promise.all([
      this.settings.readRaw(companyId),
      this.prisma.calendarDay.findMany({
        where: { companyId },
        select: { date: true, isWorking: true, label: true, departmentIds: true },
      }),
      this.prisma.workCalendar.findMany({ where: { companyId } }),
    ]);
    const overrides = new Map<string, DayOverride>(
      rows.map((r) => [
        r.date,
        { isWorking: r.isWorking, label: r.label, departmentIds: r.departmentIds ?? [] },
      ]),
    );
    const weekOf = (w: (typeof weeks)[number]): WorkWeek => ({
      workDays: [...w.workDays].sort((a, b) => a - b),
      saturdays: isSaturdayRule(w.saturdays) ? w.saturdays : 'EVERY',
      saturdayAnchor: w.saturdayAnchor,
    });
    const departments = new Map<string, WorkWeek>();
    const people = new Map<string, WorkWeek>();
    for (const w of weeks) {
      if (w.scope === 'DEPARTMENT' && w.departmentId) departments.set(w.departmentId, weekOf(w));
      if (w.scope === 'PERSON' && w.userId) people.set(w.userId, weekOf(w));
    }
    const stored = raw as { saturdays?: unknown; saturdayAnchor?: unknown };
    const patterns = patternHistoryFromStored(raw.weekPatternHistory, raw.weekPattern);
    const cal: OrgCalendar = {
      weekPattern: patternOn({ weekPattern: [], patterns, overrides }, this.today()),
      patterns,
      overrides,
      saturdays: isSaturdayRule(stored.saturdays) ? stored.saturdays : undefined,
      saturdayAnchor: typeof stored.saturdayAnchor === 'string' ? stored.saturdayAnchor : null,
      departments,
      people,
    };
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(companyId, { cal, at: now });
    return cal;
  }

  async isWorkingDay(
    companyId: string | null | undefined,
    date: string,
    who?: CalendarWho,
  ): Promise<boolean> {
    return isWorkingDay(await this.forOrg(companyId), date, who);
  }

  async dayInfo(companyId: string | null | undefined, date: string) {
    const cal = await this.forOrg(companyId);
    return { isWorkingDay: isWorkingDay(cal, date), label: dayLabel(cal, date) };
  }

  async view(companyId: string, year: number): Promise<CalendarView> {
    const cal = await this.forOrg(companyId);
    const prefix = String(year);
    const overrides = [...cal.overrides.entries()]
      .filter(([d]) => d.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, o]) => ({
        date,
        isWorking: o.isWorking,
        label: o.label,
        departmentIds: o.departmentIds ?? [],
      }));
    const weekView = ([id, w]: [string, WorkWeek]): WorkWeekView => ({
      id,
      ...w,
      saturdaysLabel: SATURDAY_RULE_LABEL[w.saturdays],
    });
    const months = Array.from({ length: 12 }, (_, i) =>
      monthSummary(cal, `${year}-${String(i + 1).padStart(2, '0')}`),
    );
    const saturdays = cal.saturdays ?? 'EVERY';
    return {
      year,
      saturdays,
      saturdayAnchor: cal.saturdayAnchor ?? null,
      saturdaysLabel: SATURDAY_RULE_LABEL[saturdays],
      departments: [...(cal.departments ?? new Map()).entries()].map(weekView),
      people: [...(cal.people ?? new Map()).entries()].map(weekView),
      weekPattern: patternOn(cal, this.today()),
      weekPatternHistory: (
        cal.patterns ?? [{ from: PATTERN_SINCE_ALWAYS, days: cal.weekPattern }]
      ).map((e) => ({ from: e.from, days: [...e.days] })),
      overrides,
      months,
    };
  }

  /**
   * The working weekdays from `from` on (default today, business time); earlier
   * days keep the pattern they had. A date in or before a month locked for payroll
   * is refused (409 MONTH_LOCKED): a locked month never changes. An earlier date
   * than today is taken only when the Admin picks it, and only in open months.
   */
  async setWeekPattern(
    companyId: string,
    days: unknown,
    by: string,
    from?: string,
  ): Promise<WeekPatternEntry> {
    const checked = checkWeekPattern(days);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'days' });
    const effective = from ?? this.today();
    if (from !== undefined) this.assertDate(from, 'from');
    const locked = await this.prisma.monthLock.findFirst({
      where: { companyId, month: { gte: effective.slice(0, 7) } },
      orderBy: { month: 'desc' },
      select: { month: true },
    });
    if (locked) throw monthLockedError(locked.month);
    const raw = await this.settings.readRaw(companyId);
    const history = withPatternFrom(
      patternHistoryFromStored(raw.weekPatternHistory, raw.weekPattern),
      effective,
      checked.days,
    );
    await this.settings.writeRaw(companyId, { weekPatternHistory: history }, by);
    await this.changed(companyId);
    return { from: effective, days: checked.days };
  }

  /** The business date today. */
  private today(): string {
    return dateKeyInZone(new Date(), appTimezone());
  }

  async setDay(
    companyId: string,
    date: string,
    isWorking: boolean,
    label: unknown,
    by: string,
    departmentIds: string[] = [],
  ): Promise<{ date: string; isWorking: boolean; label: string | null; departmentIds: string[] }> {
    this.assertDate(date);
    await this.assertMonthOpen(companyId, date);
    const clean = cleanLabel(label);
    const depts = await this.ownDepartments(companyId, departmentIds);
    await this.prisma.calendarDay.upsert({
      where: { companyId_date: { companyId, date } },
      create: { companyId, date, isWorking, label: clean, departmentIds: depts, updatedById: by },
      update: { isWorking, label: clean, departmentIds: depts, updatedById: by },
    });
    await this.changed(companyId);
    return { date, isWorking, label: clean, departmentIds: depts };
  }

  /** 3.5: the organisation's Saturday rule (ALTERNATE needs a Saturday that is worked). */
  async setSaturdays(
    companyId: string,
    rule: unknown,
    anchor: unknown,
    by: string,
  ): Promise<{ saturdays: SaturdayRule; saturdayAnchor: string | null }> {
    const week = this.checkWeek({ workDays: [6], saturdays: rule, saturdayAnchor: anchor });
    await this.settings.writeRaw(
      companyId,
      { saturdays: week.saturdays, saturdayAnchor: week.saturdayAnchor },
      by,
    );
    await this.changed(companyId);
    return { saturdays: week.saturdays, saturdayAnchor: week.saturdayAnchor };
  }

  /**
   * 3.5: a week of their own for departments or people of the organisation (one for
   * all of them). Anything not of the organisation is unknown (404).
   */
  async setWorkWeek(
    companyId: string,
    scope: 'DEPARTMENT' | 'PERSON',
    ids: string[],
    input: { workDays: unknown; saturdays: unknown; saturdayAnchor?: unknown },
    by: string,
  ): Promise<WorkWeekView[]> {
    const week = this.checkWeek(input);
    const targets = await this.ownTargets(companyId, scope, ids);
    await this.prisma.$transaction(
      targets.map((id) => {
        const key = scope === 'DEPARTMENT' ? { departmentId: id } : { userId: id };
        return this.prisma.workCalendar.upsert({
          where: key,
          create: { companyId, scope, ...key, ...week, updatedById: by },
          update: { ...week, updatedById: by },
        });
      }),
    );
    await this.changed(companyId);
    return targets.map((id) => ({
      id,
      ...week,
      saturdaysLabel: SATURDAY_RULE_LABEL[week.saturdays],
    }));
  }

  /** 3.5: back to the department's or the organisation's week. */
  async clearWorkWeek(
    companyId: string,
    scope: 'DEPARTMENT' | 'PERSON',
    ids: string[],
  ): Promise<{ cleared: number }> {
    const targets = await this.ownTargets(companyId, scope, ids);
    const res = await this.prisma.workCalendar.deleteMany({
      where: {
        companyId,
        scope,
        ...(scope === 'DEPARTMENT'
          ? { departmentId: { in: targets } }
          : { userId: { in: targets } }),
      },
    });
    await this.changed(companyId);
    return { cleared: res.count };
  }

  /** 3.5: a person's year, day by day, with what decides each day. */
  async personYear(
    companyId: string,
    who: { id: string; departmentId: string | null },
    year: number,
  ): Promise<PersonYearView> {
    const cal = await this.forOrg(companyId);
    const days: PersonYearView['days'] = [];
    for (let m = 1; m <= 12; m += 1) {
      for (const date of datesOfMonth(`${year}-${String(m).padStart(2, '0')}`)) {
        days.push({
          date,
          working: isWorkingDay(cal, date, who),
          label: dayLabel(cal, date, who),
          source: calendarSource(cal, date, who),
        });
      }
    }
    const source: CalendarSource = cal.people?.has(who.id)
      ? 'PERSON'
      : who.departmentId && cal.departments?.has(who.departmentId)
        ? 'DEPARTMENT'
        : 'ORGANISATION';
    return {
      userId: who.id,
      year,
      source,
      sourceLabel: CALENDAR_SOURCE_LABEL[source],
      workingDays: days.filter((d) => d.working).length,
      days,
    };
  }

  private checkWeek(input: {
    workDays: unknown;
    saturdays: unknown;
    saturdayAnchor?: unknown;
  }): WorkWeek {
    const checked = checkWeekPattern(input.workDays);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'workDays' });
    if (!isSaturdayRule(input.saturdays)) {
      throw new ValidationError('Pick how Saturdays are worked.').withDetails({
        field: 'saturdays',
      });
    }
    let anchor: string | null = null;
    if (input.saturdays === 'ALTERNATE') {
      const a = typeof input.saturdayAnchor === 'string' ? input.saturdayAnchor : '';
      if (!isValidDateKey(a) || new Date(`${a}T00:00:00Z`).getUTCDay() !== 6) {
        throw new ValidationError(
          'Pick a Saturday that is worked, to count alternate weeks from.',
        ).withDetails({ field: 'saturdayAnchor' });
      }
      anchor = a;
    }
    return { workDays: checked.days, saturdays: input.saturdays, saturdayAnchor: anchor };
  }

  /** Departments of the organisation among `ids` (404 for any other). */
  private async ownDepartments(companyId: string, ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = await this.prisma.department.findMany({
      where: { id: { in: unique }, companyId, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== unique.length) throw new NotFoundError('Unknown department');
    return unique;
  }

  private async ownTargets(
    companyId: string,
    scope: 'DEPARTMENT' | 'PERSON',
    ids: string[],
  ): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (!unique.length) {
      throw new ValidationError(
        scope === 'DEPARTMENT' ? 'Pick at least one department.' : 'Pick at least one person.',
      ).withDetails({ field: 'ids' });
    }
    if (scope === 'DEPARTMENT') return this.ownDepartments(companyId, unique);
    const found = await this.prisma.user.findMany({
      where: { id: { in: unique }, companyId, deletedAt: null },
      select: { id: true },
    });
    if (found.length !== unique.length) throw new NotFoundError('Unknown person');
    return unique;
  }

  async clearDay(companyId: string, date: string): Promise<{ date: string; isWorking: boolean }> {
    this.assertDate(date);
    await this.assertMonthOpen(companyId, date);
    await this.prisma.calendarDay.deleteMany({ where: { companyId, date } });
    await this.changed(companyId);
    return { date, isWorking: await this.isWorkingDay(companyId, date) };
  }

  private assertDate(date: string, field = 'date'): void {
    if (!isValidDateKey(date)) {
      throw new ValidationError('Use a date like 2026-10-20.').withDetails({ field });
    }
    const year = Number(date.slice(0, 4));
    if (year < 2000 || year > 2100) {
      throw new ValidationError('That date is out of range.').withDetails({ field });
    }
  }

  private async assertMonthOpen(companyId: string, date: string): Promise<void> {
    const lock = await this.prisma.monthLock.findUnique({
      where: { companyId_month: { companyId, month: date.slice(0, 7) } },
      select: { month: true },
    });
    if (lock) throw monthLockedError(lock.month);
  }

  private async changed(companyId: string): Promise<void> {
    this.cache.delete(companyId);
    await this.events.publish(
      OrgConfigChangedEvent.eventName,
      new OrgConfigChangedEvent(companyId, 'CALENDAR', new Date()),
    );
    // 3.4: leave and work from home on a day that stopped being worked are repriced.
    await this.events.publish(CALENDAR_CHANGED, { companyId });
  }
}
