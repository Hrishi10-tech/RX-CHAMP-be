import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import { MeetingNoteSharedEvent } from '../../domain/events/meeting-note-shared.event';
import { PresenceGateway } from '../../presentation/presence.gateway';
import { StartPresenceDto } from '../dto/start-presence.dto';
import { localDateString } from '../presence-date.util';
import { PresenceMapper } from '../presence.mapper';
import { CurrentPresenceView } from '../presence.types';

@Injectable()
export class StartPresenceUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly gateway: PresenceGateway,
  ) {}

  async execute(userId: string, dto: StartPresenceDto): Promise<CurrentPresenceView> {
    const now = new Date();
    const note = dto.note?.trim() || null;

    // Nothing more may be recorded once the user has signed off for the day.
    if (await this.dayEnds.findEnd(userId, localDateString(now))) {
      throw new ConflictException('Your working day has already ended. Tracking resumes tomorrow.');
    }

    const context = await this.team.findContext(userId);

    const { opened } = await this.sessions.switchTo(
      { userId, type: dto.type, note, date: localDateString(now) },
      now,
    );

    const current = PresenceMapper.currentFrom(opened, now);

    // Live-notify the manager that this report changed status.
    if (context?.managerId) {
      this.gateway.emitToManager(
        context.managerId,
        PresenceMapper.toTeamMemberView(context.self, current),
      );

      // A meeting note becomes a persisted notification for the manager.
      if (dto.type === 'MEETING' && note) {
        await this.events.publish(
          MeetingNoteSharedEvent.eventName,
          new MeetingNoteSharedEvent(
            context.managerId,
            userId,
            PresenceMapper.fullName(context.self),
            note,
            now,
          ),
        );
      }
    }

    return current;
  }
}
