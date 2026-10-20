import { ForbiddenError } from '@shared/exceptions/app.exception';
import { grantsOf, hasAnyGrant } from '@shared/tenancy';
import { NotFoundException, Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import {
  PRESENCE_SESSION_REPOSITORY,
  PresenceSessionRepository,
} from '../../domain/presence-session.repository';
import {
  ONLINE_SESSION_REPOSITORY,
  OnlineSessionRepository,
} from '../../domain/online-session.repository';
import { PRESENCE_TEAM_READER, PresenceTeamReader } from '../../domain/presence-team-reader.port';
import { localDateString } from '../presence-date.util';
import { PresenceMapper } from '../presence.mapper';
import { ProductivityView } from '../presence.types';

/**
 * A heuristic daily productivity score derived from presence + online data
 * (no per-app tracking):
 *   focusSec  = online − meeting   (active, non-meeting work)
 *   idleSec   = active-window span − online − break − lunch − meeting  (gaps)
 *   score/10  = productive / (productive + idle),  productive = focus + meeting
 */
@Injectable()
export class GetProductivityUseCase {
  constructor(
    @Inject(PRESENCE_SESSION_REPOSITORY) private readonly sessions: PresenceSessionRepository,
    @Inject(ONLINE_SESSION_REPOSITORY) private readonly online: OnlineSessionRepository,
    @Inject(PRESENCE_TEAM_READER) private readonly team: PresenceTeamReader,
  ) {}

  async execute(me: AuthenticatedUser, userId: string, date?: string): Promise<ProductivityView> {
    await this.authorize(me, userId);

    const now = new Date();
    const day = date ?? localDateString(now);

    const sessions = await this.sessions.listForUserByDate(userId, day);
    const totals = PresenceMapper.totals(sessions, now);
    const onlineSec = await this.online.sumSecondsForUserByDate(userId, day, now);
    const intervals = await this.online.listIntervalsForUserByDate(userId, day);

    const meetingSec = totals.meetingSec;
    const focusSec = Math.max(0, onlineSec - meetingSec);

    let spanSec = 0;
    if (intervals.length > 0) {
      const first = Math.min(...intervals.map((i) => i.start.getTime()));
      const last = Math.max(...intervals.map((i) => i.end.getTime()));
      spanSec = Math.max(0, Math.round((last - first) / 1000));
    }
    const idleSec = Math.max(
      0,
      spanSec - onlineSec - totals.breakSec - totals.lunchSec - meetingSec,
    );

    const productiveSec = focusSec + meetingSec;
    const denom = productiveSec + idleSec;
    const score = denom > 0 ? Math.round((1000 * productiveSec) / denom) / 100 : 0;

    // Online and idle time (and what is made of them: the active part and the
    // score) are activity data (re-audit L1): a Manager without the activity grant
    // sees the meetings only.
    if (me.id !== userId && !grantsOf(me).activity) {
      return { date: day, score: 0, focusSec: 0, meetingSec, idleSec: 0, onlineSec: 0 };
    }
    return { date: day, score, focusSec, meetingSec, idleSec, onlineSec };
  }

  /** 4.0: someone the caller oversees, and a Manager needs at least one grant. */
  private async authorize(me: AuthenticatedUser, userId: string): Promise<void> {
    if (me.id === userId) return;
    const reports = await this.team.findReports(me);
    if (!reports.some((r) => r.id === userId)) throw new NotFoundException('Unknown user');
    if (!hasAnyGrant(me)) {
      throw new ForbiddenError('You do not have access to this dashboard.', 'GRANT_REQUIRED');
    }
  }
}
