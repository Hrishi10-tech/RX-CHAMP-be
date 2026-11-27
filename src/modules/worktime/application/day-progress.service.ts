import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { DayProgressView, dayProgressOf } from '../domain/day-progress';
import { MOBILE_WFH_SOURCE } from '../domain/day';
import { WORK_SESSION_REPOSITORY, WorkSessionRepository } from '../domain/work-session.repository';
import { WorkSessionsService } from './work-sessions.service';
import { WorkdayService } from './workday.service';

/**
 * GET /me/day-progress (3.6): the ring and the status dot of the floating icon, for any
 * signed-in person. Built from the same day as GET /workday/me/today, so the ring always
 * matches the panel. A biometric person's status comes from their punches alone (their
 * day is open between the first punch and the last, closed once a check-out or the
 * automatic close ends it); they have no breaks or meetings.
 *
 * After End day the ring keeps that day's total until the next Start day, on a later date
 * too (brief 1.1, D-26, D-30): with nothing started today the answer is the last ended day,
 * and its `date` tells a client it is not today. Not started is for someone with no ended day.
 */
@Injectable()
export class DayProgressService {
  constructor(
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    private readonly workSessions: WorkSessionsService,
    private readonly workday: WorkdayService,
  ) {}

  async view(me: AuthenticatedUser, now: Date): Promise<DayProgressView> {
    await this.workSessions.autoCloseIfStale(me.id, now);
    const today = await this.workday.dayCore(me, now);
    const lastEnded =
      today.state === 'NOT_STARTED' ? await this.sessions.findLastEnded(me.id) : null;
    const { date, state, day, focus, expectedSec, shift, person } = lastEnded
      ? await this.workday.dayCore(me, now, lastEnded.date)
      : today;
    const biometric = person?.attendanceSource === 'BIOMETRIC';
    const open = biometric ? null : (day.presence.find((p) => p.endedAt === null) ?? null);
    const meeting = open && day.meetingRecords.find((m) => m.presenceSessionId === open.id);
    const breakRecord = open && day.breakRecords.find((r) => r.presenceSessionId === open.id);
    return dayProgressOf({
      date,
      state,
      focusSec: focus.focusSec,
      expectedSec,
      hasShift: shift !== null,
      open,
      breakDurationMin: breakRecord?.durationMin ?? null,
      meetingConfirmedAt: meeting?.kind === 'STATUS' ? (meeting.confirmedAt ?? null) : null,
      // 4.1: a remote day, started from the portal or the phone.
      remote: !lastEnded && today.open?.source === MOBILE_WFH_SOURCE,
    });
  }
}
