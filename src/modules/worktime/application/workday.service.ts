import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { approverScopeOf } from './approver-scope';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { SkipsNeedingCommentQuery } from '@modules/shifts/application/skips-needing-comment.query';
import { SkipNeedingComment } from '@modules/shifts/application/shifts.types';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import {
  DEFAULT_REASON_MIN_CHARS,
  QUICK_BREAK_MINUTES,
  ShiftRecord,
} from '@modules/shifts/domain/shift.types';
import { DayPlanService } from './day-plan.service';
import { APPROVALS_READER, ApprovalsReader } from '../domain/approvals.reader';
import { dayLeaveView, expectedAfterLeave, shiftAfterLeave } from '@modules/leave/domain/day-leave';
import { expectedSecOf, isWorkdayFor, lateStartDetail, lateStartOf } from '../domain/attendance';
import { FocusBreakdown } from '../domain/focus';
import { portalUrlFrom } from '../domain/portal-url';
import {
  LAST_ENDED_WITHIN_MS,
  WORK_SESSION_REPOSITORY,
  WorkSessionRecord,
  WorkSessionRepository,
} from '../domain/work-session.repository';
import { focusOfDay } from '../domain/day';
import { GuideItem, staffGuide } from '../domain/staff-guide';
import { DayDataService } from './day-data.service';
import { SkipsService } from './skips.service';
import { WorkSessionsService } from './work-sessions.service';
import {
  FocusView,
  WorkdayState,
  WorkdayTodayView,
  WorkdayWfhView,
  WorkSessionView,
} from './worktime.types';
import { unitsOfMask } from '@modules/leave/domain/leave.types';
import { WFH_SOURCE_LABEL, wfhMaskLabel } from '@modules/wfh/application/wfh-overview.service';
import { WfhDay } from '@modules/wfh/domain/wfh';
import { BIOMETRIC_SOURCE, MOBILE_WFH_SOURCE } from '../domain/day';
import { DayPunch, PUNCHES_READER, PunchesReader } from '../domain/punches.reader';

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
    paidBreakSec: f.paidBreakSec,
    unpaidBreakSec: f.unpaidBreakSec,
    bufferUsedSec: f.bufferUsedSec,
    quickBreakSec: f.quickBreakSec,
    awayPendingSec: f.awayPendingSec,
    awayApprovedSec: f.awayApprovedSec,
    awayRejectedSec: f.awayRejectedSec,
    awayUnexplainedSec: f.awayUnexplainedSec,
    unverifiedSec: f.unverifiedSec,
    paidSec: f.paidSec,
    adjustedSec: f.adjustedSec ?? 0,
    wfhSec: f.wfhSec,
    wfhOverSec: f.wfhOverSec,
    capRemainingSec: f.capRemainingSec,
  };
}

export function sessionView(s: WorkSessionRecord): WorkSessionView {
  return {
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? null,
    // A reopened day keeps its AUTO_CLOSED reason while open: an open session has none.
    endReason: s.endedAt ? s.endReason : null,
    source: s.source,
  };
}

/** The day's work from home as the views show it (3.5); null without any. */
export function wfhDayView(
  w: WfhDay | undefined,
  opts: { biometric: boolean; openSource: string | null; dayIsToday: boolean },
): WorkdayWfhView | null {
  if (!w || (!w.mask && !w.pendingMask)) return null;
  const running = opts.openSource === MOBILE_WFH_SOURCE;
  let startBlocked: string | null = null;
  if (!opts.biometric) startBlocked = 'Your desktop app tracks your day, at home too.';
  else if (!w.mask) startBlocked = 'Your work from home today is waiting for approval.';
  else if (!opts.dayIsToday) startBlocked = 'Work from home starts on the day itself.';
  else if (opts.openSource && !running) startBlocked = 'You are checked in at the office.';
  return {
    days: w.units / 4,
    label: w.mask ? wfhMaskLabel(w.mask) : 'Waiting for approval',
    source: w.source ?? 'REQUEST',
    sourceLabel: WFH_SOURCE_LABEL[w.source ?? 'REQUEST'] ?? 'Approved request',
    mask: w.mask,
    pendingDays: unitsOfMask(w.pendingMask) / 4,
    capSec: w.capSec,
    canStart: opts.biometric && !running && startBlocked === null,
    canEnd: running,
    startBlocked: running ? null : startBlocked,
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
    private readonly plans: DayPlanService,
    @Inject(PUNCHES_READER) private readonly punches: PunchesReader,
  ) {}

  /** GET /workday/me/today: closes a stale session and auto-skips first (lazily). */
  async today(me: AuthenticatedUser, now: Date): Promise<WorkdayTodayView> {
    await this.workSessions.autoCloseIfStale(me.id, now);
    await this.skips.autoSkipFor(me.id, now, false);
    return this.view(me, now);
  }

  /**
   * The day's numbers the panel and the ring share (3.6: one source, so they always match):
   * which working day it is, its state, focus time and expected time.
   */
  async dayCore(me: AuthenticatedUser, now: Date, forDate?: string) {
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
      (person ? this.days.dayWith(ctx, person, now).dateKey : dateKeyInZone(now, appTimezone()));
    const who = person ?? { id: me.id, companyId: me.companyId, department: me.department };
    const [data, pc] = await Promise.all([
      this.dayData.load([me.id], date, date, now, { heal: true }),
      this.plans.context([who]),
    ]);
    const day = data.day(me.id, date);
    // 4.0: the organisation's day plan decides the working day, the shift and the target.
    const plan = pc.plan(who, date);
    const shift: ShiftRecord | null = person ? plan.shift : null;
    const workday = plan.isWorkingDay;
    // Leave (3.4): a part day moves the late-start mark and shrinks what is expected.
    const leave = workday ? day.leave : undefined;
    const state: WorkdayState =
      open && open.date === date ? 'OPEN' : day.sessions.length ? 'ENDED' : 'NOT_STARTED';
    return {
      open,
      person,
      ctx,
      date,
      day,
      plan,
      focus: focusOfDay(day, now, plan.bufferMin),
      shift,
      workday,
      leave,
      state,
      // 4.0's target, less what leave covers (3.4).
      expectedSec: workday ? expectedAfterLeave(plan.targetSec, leave) : 0,
    };
  }

  /**
   * The view itself, with no side effects (also returned by Start and End Day).
   * `forDate`: that working day instead of today's (End Day answers with the day
   * it just ended, even after midnight or after a night shift).
   */
  async view(me: AuthenticatedUser, now: Date, forDate?: string): Promise<WorkdayTodayView> {
    const tz = appTimezone();
    const [core, settings, skipsNeedingComment, idle, sharedComputer] = await Promise.all([
      this.dayCore(me, now, forDate),
      this.settings.get(me.companyId),
      this.skipsQuery.forUser(me.id, now),
      this.settings.effectiveIdleFor(me.id),
      this.settings.sharedComputerFor(me.id),
    ]);
    const { open, person, ctx, date, day, focus, plan, shift, workday, state, leave } = core;
    const first = day.sessions[0] ?? null;
    const last = day.sessions[day.sessions.length - 1] ?? null;
    const bounds = shift ? shiftBounds(shift, date, tz) : null;
    const mark = shiftAfterLeave(bounds?.start ?? null, bounds?.end ?? null, leave);

    const approverScope = approverScopeOf(me);
    const biometric = person?.attendanceSource === 'BIOMETRIC';
    const [overdue, lastEnded, punches] = await Promise.all([
      approverScope ? this.approvals.overdueIn(approverScope, now) : Promise.resolve({ count: 0 }),
      state === 'NOT_STARTED' ? this.lastEnded(me.id, date, now) : Promise.resolve(null),
      biometric
        ? this.punches.punchesOf([me.id], date, date)
        : Promise.resolve(new Map<string, DayPunch[]>()),
    ]);
    const today = person ? this.days.dayWith(ctx, person, now).dateKey : dateKeyInZone(now, tz);

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
        workday && shift && first && !leave?.full
          ? lateStartDetail({
              first,
              shiftStart: mark.start,
              graceMin: settings.lateStartGraceMin,
              requireReason: settings.requireLateStartReason,
              // 4.0: nobody approves an admin's day, so nobody asks why it started late.
              exempt:
                me.role === Role.SUPER_ADMIN ||
                me.role === Role.SUPER_MANAGER ||
                me.role === Role.ADMIN,
            })
          : null,
      // 3.2: a day off by the calendar; 4.0's organisation calendar labels a holiday.
      dayOff: plan.isWorkingDay
        ? null
        : { kind: plan.label ? 'HOLIDAY' : 'WEEKLY_OFF', name: plan.label ?? null },
      shift: shift ? { id: shift.id, name: shift.name, start: shift.start, end: shift.end } : null,
      expectedSec: core.expectedSec,
      leave: workday ? dayLeaveView(day.leave) : null,
      workingFrom: leave?.mask && !leave.full ? (mark.start?.toISOString() ?? null) : null,
      workingUntil: leave?.mask && !leave.full ? (mark.end?.toISOString() ?? null) : null,
      skipsNeedingComment,
      overdueApprovals: overdue.count,
      endDayBlockedByOverdue:
        me.role === Role.MANAGER && overdue.count > 0 && settings.blockManagerEndDayWhenOverdue,
      settings: {
        approvalSlaHours: settings.approvalSlaHours,
        reasonMinChars: shift?.reasonMinChars ?? DEFAULT_REASON_MIN_CHARS,
        lateStartGraceMin: settings.lateStartGraceMin,
        requireLateStartReason: settings.requireLateStartReason,
        forgottenEndDayIdleMin: settings.forgottenEndDayIdleMin,
        // 3.2 name for 4.0's break buffer.
        paidBreakBufferMin: settings.breakBufferMin,
      },
      portalUrl: portalUrlFrom(
        this.config.get<string>('portalPublicUrl'),
        this.config.get<string[]>('corsOrigins'),
      ),
      lastEnded,
      targetSec: plan.targetSec,
      isWorkingDay: plan.isWorkingDay,
      dayLabel: plan.label,
      allowance: {
        scheduledSec: plan.allowance.scheduledSec,
        bufferSec: plan.allowance.bufferSec,
        totalSec: plan.allowance.totalSec,
        paidUsedSec: focus.paidBreakSec,
        bufferUsedSec: focus.bufferUsedSec,
        unpaidSec: focus.unpaidBreakSec,
      },
      away: { pendingSec: focus.awayPendingSec, unexplainedSec: focus.awayUnexplainedSec },
      config: {
        idle,
        quickBreakMinutes: QUICK_BREAK_MINUTES,
        breakBufferMin: settings.breakBufferMin,
        sharedComputer,
        shiftEndAt: workday && shift ? shiftBounds(shift, date, tz).end.toISOString() : null,
        extended: !!(open && open.date === date && open.extendedAt),
      },
      attendance: {
        source: biometric ? 'BIOMETRIC' : 'AGENT',
        biometricCode: person?.biometricCode ?? null,
      },
      wfh: wfhDayView(day.wfh, {
        biometric,
        openSource: open && open.date === date ? open.source : null,
        dayIsToday: date === today,
      }),
      punches: biometric
        ? (punches.get(`${me.id}|${date}`) ?? []).map((p) => ({
            at: p.at.toISOString(),
            direction: p.direction,
            deviceId: p.deviceId,
            source: p.source,
            voided: p.voided,
          }))
        : [],
      checkoutMissing:
        biometric &&
        !open &&
        day.sessions.some((s) => s.source === BIOMETRIC_SOURCE && s.endReason === 'AUTO_CLOSED'),
    };
  }

  /**
   * GET /workday/guide (3.2): how RX Vision works, with this organisation's numbers
   * and the person's own ring times (their shift today, else the defaults).
   */
  async guide(
    me: AuthenticatedUser,
    now: Date,
  ): Promise<{ items: GuideItem[]; numbers: Record<string, number> }> {
    const [settings, person, ctx] = await Promise.all([
      // 4.0: the organisation's settings.
      this.settings.get(me.companyId ?? null),
      this.people.findById(me.id),
      this.days.context([me.id]),
    ]);
    const shift = person ? this.days.dayWith(ctx, person, now).resolved.shift : null;
    const numbers = {
      paidBreakBufferMin: settings.breakBufferMin,
      lateStartGraceMin: settings.lateStartGraceMin,
      forgottenEndDayIdleMin: settings.forgottenEndDayIdleMin,
      ringLeadMin: shift?.ringLeadMin ?? 1,
      ringDurationMin: shift?.ringDurationMin ?? 5,
    };
    return { items: staffGuide(numbers), numbers };
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
    const settings = await this.settings.get(me.companyId);
    if (!settings.blockManagerEndDayWhenOverdue) return;
    const scope = approverScopeOf(me);
    if (!scope) return;
    const overdue = await this.approvals.overdueIn(scope, now);
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
  async assertSkipsCommented(
    me: AuthenticatedUser,
    now: Date,
    planned: SkipNeedingComment[] = [],
    commented: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    // Judged before anything is written: the skips already waiting, and the
    // auto-skips this End Day would create, less those commented in it.
    const breaks = [...(await this.skipsQuery.forUser(me.id, now)), ...planned].filter(
      (b) => !commented.has(b.id),
    );
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
