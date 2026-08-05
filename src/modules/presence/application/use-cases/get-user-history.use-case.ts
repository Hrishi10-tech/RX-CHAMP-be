import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRecord,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { IDLE_READER, IdleReader } from '../../domain/idle-reader.port';
import { localDateString } from '../presence-date.util';
import { PresenceMapper } from '../presence.mapper';
import { UserDailyPresenceView, UserPresenceHistoryView } from '../presence.types';

/**
 * One report's presence history over the last N days (oldest first) — powers the
 * manager's per-user "worked hours" trend chart. Manager-scoped: the target user
 * must be one of the caller's direct reports.
 */
@Injectable()
export class GetUserHistoryUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    @Inject(IDLE_READER) private readonly idle: IdleReader,
  ) {}

  async execute(managerId: string, userId: string, days = 7): Promise<UserPresenceHistoryView> {
    const now = new Date();
    const span = Math.min(31, Math.max(1, days));

    const reports = await this.team.findReports(managerId);
    const member = reports.find((r) => r.id === userId);
    if (!member) throw new ForbiddenException('That user is not one of your reports.');

    const dates = this.lastNDates(now, span);
    const sessions = await this.sessions.listForUserInDates(userId, dates);
    const onlineByDate = await this.online.sumSecondsForUserByDates(userId, dates, now);
    const idleByDate = await this.idle.sumIdleSecondsForUserByDates(userId, dates);

    // Team-average online per day, across all of the manager's reports.
    const reportIds = reports.map((r) => r.id);
    const teamAvgByDate = new Map<string, number>();
    await Promise.all(
      dates.map(async (date) => {
        const sums = await this.online.sumSecondsForUsersByDate(reportIds, date, now);
        const total = reportIds.reduce((acc, id) => acc + (sums.get(id) ?? 0), 0);
        teamAvgByDate.set(date, reportIds.length ? Math.round(total / reportIds.length) : 0);
      }),
    );

    const byDate = new Map<string, PresenceSessionRecord[]>();
    for (const s of sessions) {
      const list = byDate.get(s.date) ?? [];
      list.push(s);
      byDate.set(s.date, list);
    }

    const daysView = dates.map((date): UserDailyPresenceView => {
      const totals = PresenceMapper.totals(byDate.get(date) ?? [], now);
      totals.onlineSec = onlineByDate.get(date) ?? 0;
      totals.idleSec = idleByDate.get(date) ?? 0;
      const focusSec = Math.max(0, totals.onlineSec - totals.meetingSec);
      return { date, totals, focusSec, teamAvgOnlineSec: teamAvgByDate.get(date) ?? 0 };
    });

    return {
      userId: member.id,
      name: PresenceMapper.fullName(member),
      email: member.email,
      department: member.department,
      days: daysView,
    };
  }

  /** Local date strings for the last `n` days, oldest first, including today. */
  private lastNDates(now: Date, n: number): string[] {
    const out: string[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      out.push(localDateString(d));
    }
    return out;
  }
}
