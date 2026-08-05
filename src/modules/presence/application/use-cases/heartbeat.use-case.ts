import { Inject, Injectable } from '@nestjs/common';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { localDateString } from '../presence-date.util';

/**
 * Records an agent heartbeat into the user's online-time rollup. An active
 * heartbeat extends the current online session; an idle heartbeat closes it so
 * idle stretches don't count as online time.
 */
@Injectable()
export class HeartbeatUseCase {
  /** Gap (seconds) after which a missing heartbeat is treated as offline. */
  private static readonly GRACE_SEC = 150;

  constructor(
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
  ) {}

  async execute(userId: string, idle: boolean): Promise<void> {
    const now = new Date();
    if (idle) {
      await this.online.closeOpenForUser(userId, now);
      return;
    }
    await this.online.heartbeat(userId, localDateString(now), now, HeartbeatUseCase.GRACE_SEC);
  }
}
