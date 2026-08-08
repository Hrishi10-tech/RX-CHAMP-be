import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Role } from '@shared/rbac/roles.enum';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { ActivityMapper } from '@modules/activity/application/activity.mapper';
import { DEFAULT_WORKING_BASIS_SEC } from '@modules/activity/application/activity.constants';
import { localDateString } from '@modules/activity/application/activity-date.util';
import { ANALYTICS_READER, AnalyticsReader } from '../../domain/analytics.reader';
import { DashboardAnalytics, DayRollup, DayValue, Kpi } from '../analytics.types';
import {
  computeDayProductivity,
  deltaPct,
  detectFocusSessions,
  lastNDatesEndingAt,
  meetingWindows,
  presenceTotals,
} from '../analytics.util';

const WINDOW_DAYS = 7;

@Injectable()
export class GetDashboardAnalyticsUseCase {
  constructor(@Inject(ANALYTICS_READER) private readonly reader: AnalyticsReader) {}

  async execute(me: AuthenticatedUser, userId: string, date?: string): Promise<DashboardAnalytics> {
    await this.authorize(me, userId);

    const now = new Date();
    const day = date ?? localDateString(now);
    const dates = lastNDatesEndingAt(day, WINDOW_DAYS);

    const win = await this.reader.loadWindow(userId, dates);

    // Roll each day up once; the selected day is the last entry.
    const rollups: DayRollup[] = dates.map((d) => {
      const samples = win.samplesByDate.get(d) ?? [];
      const meetings = meetingWindows(win.presenceByDate.get(d) ?? []);
      const daily = ActivityMapper.computeDaily(
        samples,
        d,
        DEFAULT_WORKING_BASIS_SEC,
        now,
        null,
        meetings,
      );
      const presence = presenceTotals(win.presenceByDate.get(d) ?? [], now);
      const prod = computeDayProductivity(
        win.onlineByDate.get(d) ?? [],
        win.presenceByDate.get(d) ?? [],
        now,
        samples, // focus is derived from these, keeping it consistent with activeSec
      );
      return {
        date: d,
        activeSec: daily.activeSec,
        idleSec: daily.idleSec,
        breakSec: presence.breakSec,
        lunchSec: presence.lunchSec,
        meetingSec: presence.meetingSec,
        focusSec: prod.focusSec,
        score: prod.score,
        hourly: daily.hourly,
      };
    });

    const selectedIdx = rollups.length - 1;
    const selected = rollups[selectedIdx];
    const prev = selectedIdx > 0 ? rollups[selectedIdx - 1] : undefined;

    // Selected-day details straight from activity samples.
    const selectedSamples = win.samplesByDate.get(day) ?? [];
    const selectedDaily = ActivityMapper.computeDaily(
      selectedSamples,
      day,
      DEFAULT_WORKING_BASIS_SEC,
      now,
      null,
      meetingWindows(win.presenceByDate.get(day) ?? []),
    );
    const selectedPresence = presenceTotals(win.presenceByDate.get(day) ?? [], now);

    const kpi = (pick: (r: DayRollup) => number): Kpi => ({
      value: pick(selected),
      deltaPct: prev ? deltaPct(pick(selected), pick(prev)) : null,
      spark: rollups.map(pick),
    });

    const dayValues = (pick: (r: DayRollup) => number): DayValue[] =>
      rollups.map((r) => ({ date: r.date, value: pick(r) }));

    return {
      userId,
      date: day,
      generatedAt: now.toISOString(),

      kpis: {
        active: kpi((r) => r.activeSec),
        idle: kpi((r) => r.idleSec),
        break: kpi((r) => r.breakSec),
        lunch: kpi((r) => r.lunchSec),
        meeting: kpi((r) => r.meetingSec),
      },

      workVsBreak: {
        workSec: selected.activeSec,
        breakSec: selectedPresence.breakSec + selectedPresence.lunchSec,
      },
      topApps: selectedDaily.topApps,
      timeline: selectedDaily.hourly.map((h) => ({
        hour: h.hour,
        activeSec: h.activeSec,
        idleSec: h.idleSec,
      })),
      weeklyScore: dayValues((r) => r.score),
      focusTrend: dayValues((r) => r.focusSec),
      dailyFlow: rollups.flatMap((r) =>
        r.hourly.map((h) => ({
          date: r.date,
          hour: h.hour,
          activeSec: h.activeSec,
          idleSec: h.idleSec,
        })),
      ),
      focusSessions: detectFocusSessions(selectedSamples),

      distribution: { deepSec: 0, shallowSec: 0 },
      categories: [],
      taskCompletion: [],
      achievements: [],
      goals: [],
    };
  }

  private async authorize(me: AuthenticatedUser, userId: string): Promise<void> {
    if (me.id === userId) return;
    if (me.role === Role.ADMIN || me.role === Role.SUPER_ADMIN) return;
    if (me.role === Role.MANAGER) {
      const managerId = await this.reader.findManagerId(userId);
      if (managerId === me.id) return;
    }
    throw new ForbiddenException('That user is not one of your reports.');
  }
}
