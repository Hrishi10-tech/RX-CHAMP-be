import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRecord,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { localDateString } from '../presence-date.util';
import { PresenceMapper } from '../presence.mapper';
import { MeetingNoteView, TeamSummaryResult, TeamSummaryRowView } from '../presence.types';

/** Day-wise per-report rollup: how much break / lunch / meeting each took, plus meeting notes. */
@Injectable()
export class GetTeamSummaryUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
  ) {}

  async execute(managerId: string, date?: string): Promise<TeamSummaryResult> {
    const now = new Date();
    const day = date ?? localDateString(now);

    const reports = await this.team.findReports(managerId);
    if (reports.length === 0) return { date: day, rows: [] };

    const reportIds = reports.map((r) => r.id);
    const all = await this.sessions.listForUsersByDate(reportIds, day);
    const onlineByUser = await this.online.sumSecondsForUsersByDate(reportIds, day, now);

    const byUser = new Map<string, PresenceSessionRecord[]>();
    for (const s of all) {
      const list = byUser.get(s.userId) ?? [];
      list.push(s);
      byUser.set(s.userId, list);
    }

    const rows = reports.map((member): TeamSummaryRowView => {
      const list = byUser.get(member.id) ?? [];
      const open = list.find((s) => s.endedAt === null) ?? null;

      const totals = PresenceMapper.totals(list, now);
      totals.onlineSec = onlineByUser.get(member.id) ?? 0;

      const meetingNotes: MeetingNoteView[] = list
        .filter((s) => s.type === 'MEETING' && s.note)
        .map((s) => ({
          note: s.note as string,
          startedAt: s.startedAt.toISOString(),
          durationSec: PresenceMapper.sessionSeconds(s, now),
        }));

      return {
        userId: member.id,
        name: PresenceMapper.fullName(member),
        email: member.email,
        department: member.department,
        status: PresenceMapper.currentFrom(open, now).status,
        totals,
        meetingNotes,
        sessionsCount: list.length,
      };
    });

    return { date: day, rows };
  }
}
