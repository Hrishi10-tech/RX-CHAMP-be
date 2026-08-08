import { TeamMemberRef, fullName } from '@shared/types/user.types';
import { PresenceSessionRecord } from '../domain/presence-session.repository';
import { elapsedSeconds } from './presence-date.util';
import {
  CurrentPresenceView,
  PresenceSessionView,
  PresenceTotals,
  TeamMemberPresenceView,
} from './presence.types';

export class PresenceMapper {
  /**
   * The instant live figures are measured against. Normally "now", but once the
   * user has ended their day everything freezes at `endedAt` — no total may keep
   * growing past the minute they signed off.
   */
  static asOf(now: Date, endedAt: Date | null): Date {
    return endedAt && endedAt < now ? endedAt : now;
  }

  /** Seconds a session contributes to a total: its duration if closed, else live elapsed. */
  static sessionSeconds(s: PresenceSessionRecord, now: Date): number {
    return s.endedAt ? (s.durationSec ?? 0) : elapsedSeconds(s.startedAt, now);
  }

  static emptyTotals(): PresenceTotals {
    return { breakSec: 0, lunchSec: 0, meetingSec: 0, onlineSec: 0, idleSec: 0 };
  }

  static totals(sessions: PresenceSessionRecord[], now: Date): PresenceTotals {
    const t = this.emptyTotals();
    for (const s of sessions) {
      const secs = this.sessionSeconds(s, now);
      if (s.type === 'BREAK') t.breakSec += secs;
      else if (s.type === 'LUNCH') t.lunchSec += secs;
      else if (s.type === 'MEETING') t.meetingSec += secs;
    }
    return t;
  }

  /**
   * The user's live status. `dayEnded` wins outright — End Day closes any open
   * session, so there is nothing left to report and the board must show that they
   * have signed off rather than falling back to WORKING.
   */
  static currentFrom(
    open: PresenceSessionRecord | null,
    now: Date,
    dayEnded = false,
  ): CurrentPresenceView {
    if (dayEnded) {
      return { status: 'DAY_ENDED', sessionId: null, note: null, since: null, elapsedSec: 0 };
    }
    if (!open) {
      return { status: 'WORKING', sessionId: null, note: null, since: null, elapsedSec: 0 };
    }
    return {
      status: open.type,
      sessionId: open.id,
      note: open.note,
      since: open.startedAt.toISOString(),
      elapsedSec: elapsedSeconds(open.startedAt, now),
    };
  }

  static fullName(m: Pick<TeamMemberRef, 'firstName' | 'lastName'>): string {
    return fullName(m);
  }

  static toTeamMemberView(
    member: TeamMemberRef,
    current: CurrentPresenceView,
  ): TeamMemberPresenceView {
    return {
      userId: member.id,
      name: fullName(member),
      email: member.email,
      department: member.department,
      status: current.status,
      note: current.note,
      since: current.since,
      elapsedSec: current.elapsedSec,
    };
  }

  static toSessionView(s: PresenceSessionRecord, now: Date): PresenceSessionView {
    return {
      id: s.id,
      type: s.type,
      note: s.note,
      startedAt: s.startedAt.toISOString(),
      endedAt: s.endedAt ? s.endedAt.toISOString() : null,
      durationSec: this.sessionSeconds(s, now),
    };
  }
}
