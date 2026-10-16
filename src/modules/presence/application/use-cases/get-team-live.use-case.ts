import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRecord,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import {
  WORK_SESSION_STATE_READER,
  WorkSessionStateReader,
  notStarted,
} from '../../domain/work-session-state.reader';
import { PresenceMapper } from '../presence.mapper';
import { localDateString } from '../presence-date.util';
import { TeamMemberPresenceView } from '../presence.types';

/** A manager's live board: every report and what they're doing right now. */
@Injectable()
export class GetTeamLiveUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
    @Inject(WORK_SESSION_STATE_READER) private readonly workSessions: WorkSessionStateReader,
  ) {}

  async execute(managerId: string): Promise<TeamMemberPresenceView[]> {
    const now = new Date();
    const reports = await this.team.findReports(managerId);
    if (reports.length === 0) return [];

    const ids = reports.map((r) => r.id);
    const open = await this.sessions.listOpenForUsers(ids);
    // Reports who signed off read as DAY_ENDED rather than falling back to WORKING;
    // reports with no work session on their working day (3.1) read as NOT_STARTED.
    // The working day is each person's shift-day (night shifts), else the calendar day.
    const states = await this.workSessions.statesFor(ids, now);
    const byDay = new Map<string, string[]>();
    for (const id of ids) {
      const day = states.get(id)?.today ?? localDateString(now);
      byDay.set(day, [...(byDay.get(day) ?? []), id]);
    }
    const ended = new Set<string>();
    for (const [day, dayIds] of byDay) {
      for (const id of (await this.dayEnds.findEndsForUsers(dayIds, day)).keys()) ended.add(id);
    }

    // Latest open session per user (there should only be one, but be defensive).
    const openByUser = new Map<string, PresenceSessionRecord>();
    for (const s of open) {
      if (!openByUser.has(s.userId)) openByUser.set(s.userId, s);
    }

    return reports.map((member) =>
      PresenceMapper.toTeamMemberView(
        member,
        PresenceMapper.currentFrom(
          openByUser.get(member.id) ?? null,
          now,
          ended.has(member.id),
          notStarted(states.get(member.id)),
        ),
      ),
    );
  }
}
