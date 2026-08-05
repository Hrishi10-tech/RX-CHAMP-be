import { Inject, Injectable } from '@nestjs/common';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import { PresenceMapper } from '../presence.mapper';
import { CurrentPresenceView } from '../presence.types';

@Injectable()
export class GetCurrentPresenceUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
  ) {}

  async execute(userId: string): Promise<CurrentPresenceView> {
    const open = await this.sessions.findOpenForUser(userId);
    return PresenceMapper.currentFrom(open, new Date());
  }
}
