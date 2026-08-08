import { Inject, Injectable } from '@nestjs/common';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { DAY_END_READER, DayEndReader } from '../../domain/day-end.reader';
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
    @Inject(DAY_END_READER) private readonly dayEnds: DayEndReader,
  ) {}

  async execute(userId: string, idle: boolean): Promise<void> {
    const now = new Date();
    const day = localDateString(now);

    // The day's attendance is final once it has been ended. A stray heartbeat —
    // an agent that hasn't noticed yet, or one restarted after signing off —
    // must not reopen the online session; close anything still open instead.
    if (await this.dayEnds.findEnd(userId, day)) {
      await this.online.closeOpenForUser(userId, now);
      return;
    }

    if (idle) {
      await this.online.closeOpenForUser(userId, now);
      return;
    }
    await this.online.heartbeat(userId, day, now, HeartbeatUseCase.GRACE_SEC);
  }
}
