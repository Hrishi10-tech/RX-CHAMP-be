import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRecord,
  PresenceSessionRepository,
} from '@modules/presence/domain/presence-session.repository';
import {
  PRESENCE_TEAM_READER,
  PresenceTeamReader,
} from '@modules/presence/domain/presence-team-reader.port';
import { DAY_END_READER, DayEndReader } from '@modules/presence/domain/day-end.reader';
import { PresenceMapper } from '@modules/presence/application/presence.mapper';
import { PresenceGateway } from '@modules/presence/presentation/presence.gateway';

/**
 * The few presence operations the break flow needs: end the running break, and
 * push the change to the manager's live board. Kept in one adapter so the
 * shifts module touches the presence module in exactly one place.
 */
@Injectable()
export class PresenceBridge {
  private readonly logger = new Logger(PresenceBridge.name);

  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
    private readonly gateway: PresenceGateway,
  ) {}

  /** Whether the person pressed End Day for this local calendar day. */
  async dayEnded(userId: string, calendarDay: string): Promise<boolean> {
    return (await this.dayEnds.findEnd(userId, calendarDay)) !== null;
  }

  findOpen(userId: string): Promise<PresenceSessionRecord | null> {
    return this.sessions.findOpenForUser(userId);
  }

  endOpen(userId: string, now: Date): Promise<PresenceSessionRecord | null> {
    return this.sessions.endOpenForUser(userId, now);
  }

  /** Tells the person's manager their status changed (best effort, never throws). */
  async broadcast(userId: string, open: PresenceSessionRecord | null, now: Date): Promise<void> {
    try {
      const context = await this.team.findContext(userId);
      if (!context) return;
      await this.gateway.emitForSubject(
        userId,
        PresenceMapper.toTeamMemberView(context.self, PresenceMapper.currentFrom(open, now)),
      );
    } catch (err) {
      this.logger.warn(`live presence push for ${userId} failed: ${(err as Error).message}`);
    }
  }
}
