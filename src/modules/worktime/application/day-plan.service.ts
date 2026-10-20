import { Injectable } from '@nestjs/common';
import { AppSettings } from '@modules/settings/domain/settings.rules';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { CalendarService } from '@modules/calendar/application/calendar.service';
import { dayLabel, isWorkingDay, OrgCalendar } from '@modules/calendar/domain/calendar.rules';
import { BreakDayService, ResolutionContext } from '@modules/shifts/application/break-day.service';
import { PersonForShift } from '@modules/shifts/domain/shift-resolution';
import { ShiftRecord } from '@modules/shifts/domain/shift.types';
import { allowanceOf, targetSecOf } from '../domain/attendance';

/** What a person's day is meant to be (docs/4.0/SPEC.md 2.4, 2.6). */
export interface DayPlan {
  date: string;
  /** From the organisation calendar (week pattern and overrides). */
  isWorkingDay: boolean;
  /** The calendar's label for the date (a holiday's name), or null. */
  label: string | null;
  shift: ShiftRecord | null;
  bufferMin: number;
  /** Scheduled breaks of the shift, the buffer and their sum (seconds). */
  allowance: { scheduledSec: number; bufferSec: number; totalSec: number };
  shiftLengthSec: number;
  /** The day's focus target (0 on a non-working day). */
  targetSec: number;
}

type PlanPerson = PersonForShift & { companyId: string | null };

/** Resolved shifts, calendars and settings for many people at once (no per-person queries). */
export class PlanContext {
  constructor(
    private readonly days: BreakDayService,
    readonly shifts: ResolutionContext,
    private readonly calendars: Map<string, OrgCalendar>,
    private readonly settingsByOrg: Map<string, AppSettings>,
    private readonly fallbackCalendar: OrgCalendar,
    private readonly fallbackSettings: AppSettings,
  ) {}

  settingsOf(companyId: string | null): AppSettings {
    return (companyId && this.settingsByOrg.get(companyId)) || this.fallbackSettings;
  }

  calendarOf(companyId: string | null): OrgCalendar {
    return (companyId && this.calendars.get(companyId)) || this.fallbackCalendar;
  }

  plan(person: PlanPerson, date: string): DayPlan {
    const shift = this.days.resolveWith(this.shifts, person, date).shift;
    const cal = this.calendarOf(person.companyId);
    const working = isWorkingDay(cal, date);
    const bufferMin = this.settingsOf(person.companyId).breakBufferMin;
    const a = allowanceOf(shift, bufferMin);
    return {
      date,
      isWorkingDay: working,
      label: dayLabel(cal, date),
      shift,
      bufferMin,
      allowance: { scheduledSec: a.scheduledSec, bufferSec: a.bufferSec, totalSec: a.totalSec },
      shiftLengthSec: a.shiftLengthSec,
      targetSec: targetSecOf(shift, bufferMin, working),
    };
  }
}

/**
 * The day plan service: everything targets, day classes, the allowance and History
 * need besides the day's own records. One read of shifts, calendars and settings
 * for any number of people.
 */
@Injectable()
export class DayPlanService {
  constructor(
    private readonly days: BreakDayService,
    private readonly calendar: CalendarService,
    private readonly settings: AppSettingsService,
  ) {}

  async context(people: PlanPerson[]): Promise<PlanContext> {
    const orgs = [...new Set(people.map((p) => p.companyId).filter((c): c is string => !!c))];
    const [shifts, calendars, settings, fallbackCalendar, fallbackSettings] = await Promise.all([
      this.days.context(people.map((p) => p.id)),
      Promise.all(orgs.map(async (o) => [o, await this.calendar.forOrg(o)] as const)),
      Promise.all(orgs.map(async (o) => [o, await this.settings.get(o)] as const)),
      this.calendar.forOrg(null),
      this.settings.get(null),
    ]);
    return new PlanContext(
      this.days,
      shifts,
      new Map(calendars),
      new Map(settings),
      fallbackCalendar,
      fallbackSettings,
    );
  }
}
