import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
import { MeetingNoteSharedEvent } from '../../domain/events/meeting-note-shared.event';
import { PresenceStartedEvent } from '../../domain/events/presence-started.event';
import { PresenceGateway } from '../../presentation/presence.gateway';
import { PresenceDayGate } from '../presence-day.gate';
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
    private readonly day: PresenceDayGate,
  ) {}

  /**
   * `now` is the request's clock (RequestClock: a replayed agent action's own
   * time). A 3.1+ agent needs its day open (409 DAY_NOT_STARTED / DAY_ENDED, as
   * every other agent action) and the status is dated on that working day.
   */
  async execute(
    userId: string,
    dto: StartPresenceDto,
    generation: 'AGENT_31' | 'LEGACY' = 'LEGACY',
    now: Date = new Date(),
  ): Promise<CurrentPresenceView> {
    const note = dto.note?.trim() || null;

    let date = localDateString(now);
    if (generation === 'AGENT_31') {
      const open = await this.day.ensureOpen(userId, generation, now);
      if (open) date = open.date;
    } else if (await this.dayEnds.findEnd(userId, date)) {
      // Nothing more may be recorded once the user has signed off for the day.
      throw new ConflictException('Your working day has already ended. Tracking resumes tomorrow.');
    }

    const context = await this.team.findContext(userId);

    const { opened } = await this.sessions.switchTo({ userId, type: dto.type, note, date }, now);

    const current = PresenceMapper.currentFrom(opened, now);

    // Lets the break schedule record (and if needed send for approval) a break
    // started this way, e.g. by an agent older than scheduled breaks.
    await this.events.publish(
      PresenceStartedEvent.eventName,
      new PresenceStartedEvent(userId, opened.id, dto.type, now),
    );

    // Live-notify whoever oversees this person that their status changed.
    if (context) {
      await this.gateway.emitForSubject(
        userId,
        PresenceMapper.toTeamMemberView(context.self, current),
      );
    }
    // A meeting note becomes a persisted notification for whoever oversees them
    // (4.0: the notifications module resolves department managers or the Admin).
    if (context && dto.type === 'MEETING' && note) {
      await this.events.publish(
        MeetingNoteSharedEvent.eventName,
        new MeetingNoteSharedEvent(
          context.managerId ?? null,
          userId,
          PresenceMapper.fullName(context.self),
          note,
          now,
        ),
      );
    }

    return current;
  }
}
