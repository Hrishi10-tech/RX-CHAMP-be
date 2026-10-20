import { Injectable } from '@nestjs/common';
import { ForbiddenError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { ShiftDayResolver } from '@modules/shifts/application/shift-day.resolver';
import { activeMinOf, quietHoursOf } from '../domain/hourly';
import { DayDataService } from './day-data.service';
import { PeopleScopeService } from './people-scope.service';
import { HourlyActivityView } from './worktime.types';

/**
 * GET /activity/user/:userId/hourly (SPEC 3.6): hourly activity of one person's
 * working day (the same numbers as Team today and the reports), for their manager
 * or a Super Admin. Staff never see activity, not even their own: 403 for a USER.
 */
@Injectable()
export class HourlyActivityService {
  constructor(
    private readonly scope: PeopleScopeService,
    private readonly dayData: DayDataService,
    private readonly settings: AppSettingsService,
    private readonly dayKeys: ShiftDayResolver,
  ) {}

  async forUser(
    me: AuthenticatedUser,
    userId: string,
    date: string | undefined,
    now: Date,
  ): Promise<HourlyActivityView> {
    if (me.role === Role.USER) throw new ForbiddenError('Activity is visible to managers only.');
    // 4.0: a Manager needs the activity grant.
    const person = await this.scope.personSection(me, userId, 'activity');
    // Default: the person's working day now (a night shift's hours stay together).
    const day = date ?? (await this.dayKeys.dayKeyAt(userId, now));
    const [data, settings] = await Promise.all([
      this.dayData.load([userId], day, day, now, { heal: true }),
      this.settings.get(person.companyId),
    ]);
    const hours = await this.dayData.hourlyFor(
      data.day(userId, day),
      now,
      settings.quietHourActiveMin,
    );
    return { date: day, hours, activeMin: activeMinOf(hours), quietHours: quietHoursOf(hours) };
  }
}
