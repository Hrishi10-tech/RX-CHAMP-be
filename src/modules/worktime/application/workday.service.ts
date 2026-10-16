import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { SkipsNeedingCommentQuery } from '@modules/shifts/application/skips-needing-comment.query';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import { DEFAULT_REASON_MIN_CHARS, ShiftRecord } from '@modules/shifts/domain/shift.types';
import { APPROVALS_READER, ApprovalsReader } from '../domain/approvals.reader';
import { expectedSecOf, isWorkdayFor, lateStartOf } from '../domain/attendance';
import { FocusBreakdown } from '../domain/focus';
import { portalUrlFrom } from '../domain/portal-url';
import {
  LAST_ENDED_WITHIN_MS,
  WORK_SESSION_REPOSITORY,
  WorkSessionRecord,
  WorkSessionRepository,
} from '../domain/work-session.repository';
import { focusOfDay } from '../domain/day';
import { DayDataService } from './day-data.service';
import { SkipsService } from './skips.service';
import { WorkSessionsService } from './work-sessions.service';
import { FocusView, WorkdayTodayView, WorkSessionView } from './worktime.types';

export function focusView(f: FocusBreakdown): FocusView {
  return {
    focusSec: f.focusSec,
    running: f.running,
    spanSec: f.spanSec,
    breakSec: f.breakSec,
    meetingSec: f.meetingSec,
    approvedPlusSec: f.approvedPlusSec,
    pendingPlusSec: f.pendingPlusSec,
    rejectedMinusSec: f.rejectedMinusSec,
    pendingMinusSec: f.pendingMinusSec,
  };
}

export function sessionView(s: WorkSessionRecord): WorkSessionView {
  return {
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    endReason: s.endReason,
  };
}

/** The working day as the agent sees it (SPEC 3.1), and the End Day gates. */
@Injectable()
export class WorkdayService {
  constructor(
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    @Inject(APPROVALS_READER) private readonly approvals: ApprovalsReader,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly workSessions: WorkSessionsService,
    private readonly skips: SkipsService,
    private readonly dayData: DayDataService,
    private readonly days: BreakDayService,
    private readonly skipsQuery: SkipsNeedingCommentQuery,
    private readonly settings: AppSettingsService,
    private readonly config: ConfigService,
  ) {}

  /** GET /workday/me/today: closes a stale session and auto-skips first (lazily). */
  async today(me: AuthenticatedUser, now: Date): Promise<WorkdayTodayView> {
    await this.workSessions.autoCloseIfStale(me.id, now);
    await this.skips.autoSkipFor(me.id, now, false);
    return this.view(me, now);
  }

  /**
   * The view itself, with no side effects (also returned by Start and End Day).
   * `forDate`: that working day instead of today's (End Day answers with the day
   * it just ended, even after midnight or after a night shift).
   */
  async view(me: AuthenticatedUser, now: Date, forDate?: string): Promise<WorkdayTodayView> {
    const tz = appTimezone();
    const [open, person, ctx] = await Promise.all([
      this.sessions.findOpen(me.id),
      this.people.findById(me.id),
      this.days.context([me.id]),
    ]);
    // The working day: an open session keeps its day (past midnight too); else the
    // person's shift-day of now (an overnight shift's early hours belong to the
    // evening before), else the calendar day.
    const date =
      forDate ??
      open?.date ??
      (person ? this.days.dayWith(ctx, person, now).dateKey : dateKeyInZone(now, tz));
    const [data, settings, skipsNeedingComment] = await Promise.all([
      this.dayData.load([me.id], date, date, now, { heal: true }),
      this.settings.get(),
      this.skipsQuery.forUser(me.id, now),
    ]);
    const day = data.day(me.id, date);
    const focus = focusOfDay(day, now);
    const shift: ShiftRecord | null = person
      ? this.days.resolveWith(ctx, person, date).shift
      : null;
    const workday = isWorkdayFor(shift, date);
    const first = day.sessions[0] ?? null;
    const last = day.sessions[day.sessions.length - 1] ?? null;
    const state =
      open && open.date === date ? 'OPEN' : day.sessions.length ? 'ENDED' : 'NOT_STARTED';

    const approver = me.role === Role.MANAGER || me.role === Role.SUPER_ADMIN;
    const [overdue, lastEnded] = await Promise.all([
      approver ? this.approvals.overdueRoutedTo(me.id, now) : Promise.resolve({ count: 0 }),
      state === 'NOT_STARTED' ? this.lastEnded(me.id, date, now) : Promise.resolve(null),
    ]);

    return {
      date,
      serverNow: now.toISOString(),
      timezone: tz,
      state,
      startedAt: first?.startedAt.toISOString() ?? null,
      endedAt: state === 'ENDED' ? (last?.endedAt?.toISOString() ?? null) : null,
      autoClosed: !open && last?.endReason === 'AUTO_CLOSED',
      sessions: day.sessions.map(sessionView),
      focus: focusView(focus),
      lateStart:
        workday && shift && first
          ? lateStartOf(
              first.startedAt,
              shiftBounds(shift, date, tz).start,
              settings.lateStartGraceMin,
            )
          : null,
      shift: shift ? { id: shift.id, name: shift.name, start: shift.start, end: shift.end } : null,
      expectedSec: workday ? expectedSecOf(shift) : 0,
      skipsNeedingComment,
      overdueApprovals: overdue.count,
      endDayBlockedByOverdue:
        me.role === Role.MANAGER && overdue.count > 0 && settings.blockManagerEndDayWhenOverdue,
      settings: {
        approvalSlaHours: settings.approvalSlaHours,
        reasonMinChars: shift?.reasonMinChars ?? DEFAULT_REASON_MIN_CHARS,
      },
      portalUrl: portalUrlFrom(
        this.config.get<string>('portalPublicUrl'),
        this.config.get<string[]>('corsOrigins'),
      ),
      lastEnded,
    };
  }

  /** The day ended within LAST_ENDED_WITHIN_MS before now (not `date`), with its focus. */
  private async lastEnded(
    userId: string,
    date: string,
    now: Date,
  ): Promise<WorkdayTodayView['lastEnded']> {
    const last = await this.sessions.findLastEnded(userId);
    if (!last?.endedAt || last.date === date) return null;
    if (now.getTime() - last.endedAt.getTime() > LAST_ENDED_WITHIN_MS) return null;
    const data = await this.dayData.load([userId], last.date, last.date, now);
    return {
      date: last.date,
      endedAt: last.endedAt.toISOString(),
      focusSec: focusOfDay(data.day(userId, last.date), now).focusSec,
    };
  }

  /**
   * End Day gates for a 3.1 agent (SPEC 1.4, 1.7), in the order End Day applies
   * them: a Manager's overdue approvals first (before any skip is made for an open
   * window), then every skip still waiting for a comment (last 31 days). Super
   * Admins are never gated by approvals (their items need none).
   */
  async assertCanEndDay(me: AuthenticatedUser, now: Date): Promise<void> {
    await this.assertNoOverdueApprovals(me, now);
    await this.assertSkipsCommented(me, now);
  }

  /** 409 APPROVALS_OVERDUE for a Manager with items past due, while the setting is on. */
  async assertNoOverdueApprovals(me: AuthenticatedUser, now: Date): Promise<void> {
    if (me.role !== Role.MANAGER) return;
    const settings = await this.settings.get();
    if (!settings.blockManagerEndDayWhenOverdue) return;
    const overdue = await this.approvals.overdueRoutedTo(me.id, now);
    if (overdue.count > 0) {
      throw new ConflictError(
        `${overdue.count === 1 ? '1 approval is' : `${overdue.count} approvals are`} past ` +
          `${settings.approvalSlaHours} hours. Decide them in the portal to end your day.`,
        'APPROVALS_OVERDUE',
      ).withDetails({
        count: overdue.count,
        oldestDueAt: overdue.oldestDueAt?.toISOString() ?? null,
      });
    }
  }

  /** 409 SKIP_COMMENTS_REQUIRED listing every skip still waiting for a comment. */
  async assertSkipsCommented(me: AuthenticatedUser, now: Date): Promise<void> {
    const breaks = await this.skipsQuery.forUser(me.id, now);
    if (breaks.length) {
      throw new ConflictError(
        breaks.length === 1
          ? 'Add a comment to your skipped break before you end the day.'
          : `Add a comment to each of your ${breaks.length} skipped breaks before you end the day.`,
        'SKIP_COMMENTS_REQUIRED',
      ).withDetails({ breaks });
    }
  }
}
