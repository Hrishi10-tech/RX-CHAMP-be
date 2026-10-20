import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { monthLockedError } from '@shared/database/month-lock';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import { ValidationError } from '@shared/exceptions/app.exception';
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
} from '../domain/calendar.rules';

const CACHE_MS = 30_000;

export interface CalendarView {
  year: number;
  /** The week pattern in force today. */
  weekPattern: number[];
  /** Every pattern and the date it applies from, oldest first (the first: since always). */
  weekPatternHistory: WeekPatternEntry[];
  overrides: { date: string; isWorking: boolean; label: string | null }[];
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
    const [raw, rows] = await Promise.all([
      this.settings.readRaw(companyId),
      this.prisma.calendarDay.findMany({
        where: { companyId },
        select: { date: true, isWorking: true, label: true },
      }),
    ]);
    const overrides = new Map<string, DayOverride>(
      rows.map((r) => [r.date, { isWorking: r.isWorking, label: r.label }]),
    );
    const patterns = patternHistoryFromStored(raw.weekPatternHistory, raw.weekPattern);
    const cal: OrgCalendar = {
      weekPattern: patternOn({ weekPattern: [], patterns, overrides }, this.today()),
      patterns,
      overrides,
    };
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(companyId, { cal, at: now });
    return cal;
  }

  async isWorkingDay(companyId: string | null | undefined, date: string): Promise<boolean> {
    return isWorkingDay(await this.forOrg(companyId), date);
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
      .map(([date, o]) => ({ date, isWorking: o.isWorking, label: o.label }));
    const months = Array.from({ length: 12 }, (_, i) =>
      monthSummary(cal, `${year}-${String(i + 1).padStart(2, '0')}`),
    );
    return {
      year,
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
  ): Promise<{ date: string; isWorking: boolean; label: string | null }> {
    this.assertDate(date);
    await this.assertMonthOpen(companyId, date);
    const clean = cleanLabel(label);
    await this.prisma.calendarDay.upsert({
      where: { companyId_date: { companyId, date } },
      create: { companyId, date, isWorking, label: clean, updatedById: by },
      update: { isWorking, label: clean, updatedById: by },
    });
    await this.changed(companyId);
    return { date, isWorking, label: clean };
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
  }
}
