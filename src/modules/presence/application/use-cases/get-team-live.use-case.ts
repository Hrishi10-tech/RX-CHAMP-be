import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRecord,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { PresenceMapper } from '../presence.mapper';
import { TeamMemberPresenceView } from '../presence.types';

/** A manager's live board: every report and what they're doing right now. */
@Injectable()
export class GetTeamLiveUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
  ) {}

  async execute(managerId: string): Promise<TeamMemberPresenceView[]> {
    const now = new Date();
    const reports = await this.team.findReports(managerId);
    if (reports.length === 0) return [];

    const open = await this.sessions.listOpenForUsers(reports.map((r) => r.id));

    // Latest open session per user (there should only be one, but be defensive).
    const openByUser = new Map<string, PresenceSessionRecord>();
    for (const s of open) {
      if (!openByUser.has(s.userId)) openByUser.set(s.userId, s);
    }

    return reports.map((member) =>
      PresenceMapper.toTeamMemberView(
        member,
        PresenceMapper.currentFrom(openByUser.get(member.id) ?? null, now),
      ),
    );
  }
}
