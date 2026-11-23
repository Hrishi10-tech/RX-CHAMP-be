import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { LeaveDaysService } from '@modules/leave/application/leave-days.service';
import { DayLeave, leaveOn, shiftAfterLeave } from '@modules/leave/domain/day-leave';
import { ConflictError, NotFoundError, UnprocessableError } from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { appTimezone, hmInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { DayPlanService } from './day-plan.service';
import { ReasonPresetsService } from '@modules/settings/application/reason-presets.service';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { ShiftDayResolver } from '@modules/shifts/application/shift-day.resolver';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import { DEFAULT_REASON_MIN_CHARS } from '@modules/shifts/domain/shift.types';
import { AgentCaps } from '../domain/agent-generation';
import {
  LATE_REASON_MAX_CHARS,
  lateStartDetail,
  LateStartDetail,
  lateStartOf,
} from '../domain/attendance';
import { lateStartReasonCopy, NOTICE } from '../domain/notice-copy';
import { WORK_SESSION_REPOSITORY, WorkSessionRepository } from '../domain/work-session.repository';

/** A first Start Day that comes later than the shift start plus the grace. */
export interface LateFirstStart {
  date: string;
  minutes: number;
  graceMin: number;
  shiftStart: Date;
  minChars: number;
  /** The setting is on and the person reports to someone. */
  reasonRequired: boolean;
}

function clean(text: string | null | undefined): string | null {
  const t = (text ?? '').trim().replace(/\s+/g, ' ');
  return t.length ? t : null;
}

/**
 * Late check-in (3.2, fix 1). Starting within `lateStartGraceMin` of the shift start
 * asks nothing. Later than that, the person says why: a 3.2 agent asks before the
 * day starts (422 LATE_REASON_REQUIRED, then Start Day again with `lateReason`); an
 * older agent starts the day as before and the person adds the reason in the
 * portal. Managers see the reason on Team today and in the reports. Only working
 * days count; Super Admins report to nobody and are never asked.
 */
/** 4.0: nobody approves an admin's day, so nobody asks why it started late. */
function isExempt(role: string): boolean {
  return role === 'SUPER_ADMIN' || role === 'SUPER_MANAGER' || role === 'ADMIN';
}

@Injectable()
export class LateStartService {
  private readonly logger = new Logger(LateStartService.name);

  constructor(
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
    private readonly dayKeys: ShiftDayResolver,
    private readonly settings: AppSettingsService,
    private readonly presets: ReasonPresetsService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly plans: DayPlanService,
    @Optional() private readonly leaveDays?: LeaveDaysService,
  ) {}

  /** Approved leave of a person on a day (3.4). */
  private async leaveOf(userId: string, date: string): Promise<DayLeave | undefined> {
    if (!this.leaveDays) return undefined;
    return leaveOn(await this.leaveDays.byDay([userId], date, date), userId, date);
  }

  /** The late-start mark: the shift start, or the end of leave at the start of the day. */
  private markOf(
    shift: Parameters<typeof shiftBounds>[0],
    date: string,
    leave: DayLeave | undefined,
  ): Date {
    const b = shiftBounds(shift, date, appTimezone());
    return shiftAfterLeave(b.start, b.end, leave).start ?? b.start;
  }

  /** Whether a Start Day at `startedAt` would be the day's late first start. */
  async lateFirstStart(person: ShiftPerson, startedAt: Date): Promise<LateFirstStart | null> {
    const dayOf = await this.dayKeys.keyFnFor(person.id);
    const date = dayOf(startedAt);
    const [pc, open, today] = await Promise.all([
      this.plans.context([person]),
      this.sessions.findOpen(person.id),
      this.sessions.listForUserOnDate(person.id, date),
    ]);
    // A day already running, or resumed after End Day: not the first start.
    if (open || today.length) return null;
    // 4.0: the organisation's calendar and settings decide.
    const settings = pc.settingsOf(person.companyId);
    const plan = pc.plan(person, date);
    const shift = plan.shift;
    if (!shift || !plan.isWorkingDay) return null;
    // A day of leave is never a late start; leave at its start moves the mark (3.4).
    const leave = await this.leaveOf(person.id, date);
    if (leave?.full) return null;
    const shiftStart = this.markOf(shift, date, leave);
    const late = lateStartOf(startedAt, shiftStart, settings.lateStartGraceMin);
    if (!late) return null;
    return {
      date,
      minutes: late.minutes,
      graceMin: settings.lateStartGraceMin,
      shiftStart,
      minChars: shift.reasonMinChars ?? DEFAULT_REASON_MIN_CHARS,
      reasonRequired: settings.requireLateStartReason && !isExempt(person.role),
    };
  }

  /**
   * Before Start Day opens the session. Returns the reason to keep (null: none
   * needed or none given). An agent that can ask gets 422 LATE_REASON_REQUIRED
   * while the reason is missing or too short.
   */
  async gate(
    me: AuthenticatedUser,
    startedAt: Date,
    lateReason: string | undefined,
    caps: AgentCaps,
  ): Promise<{ late: LateFirstStart; reason: string | null } | null> {
    const person = await this.people.findById(me.id);
    if (!person) return null;
    const late = await this.lateFirstStart(person, startedAt);
    if (!late) return null;
    const reason = clean(lateReason);
    if (reason && reason.length > LATE_REASON_MAX_CHARS) {
      throw new UnprocessableError(
        `Keep the reason under ${LATE_REASON_MAX_CHARS} characters.`,
        'REASON_TOO_LONG',
      ).withDetails({ maxChars: LATE_REASON_MAX_CHARS });
    }
    const enough = await this.presets.accepts('LATE_DAY_START', reason, late.minChars);
    if (caps.lateStartReason && late.reasonRequired && !enough) {
      const presets = await this.presets.get();
      throw new UnprocessableError(
        `You're starting ${late.minutes} minutes after your shift start (${hmInZone(late.shiftStart, appTimezone())}). ` +
          `Say why (at least ${late.minChars} characters).`,
        'LATE_REASON_REQUIRED',
      ).withDetails({
        date: late.date,
        minutesLate: late.minutes,
        graceMin: late.graceMin,
        shiftStart: late.shiftStart.toISOString(),
        minChars: late.minChars,
        maxChars: LATE_REASON_MAX_CHARS,
        presets: presets.LATE_DAY_START,
      });
    }
    return { late, reason: reason && enough ? reason : null };
  }

  /**
   * After Start Day opened a late first start with no reason (an agent that cannot
   * ask): tells the person to add it in the portal. Best effort.
   */
  async remind(userId: string, late: LateFirstStart): Promise<void> {
    if (!late.reasonRequired) return;
    try {
      const copy = lateStartReasonCopy({ minutes: late.minutes, graceMin: late.graceMin });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([userId], NOTICE.LATE_START_REASON, copy.title, copy.body),
      );
    } catch (err) {
      this.logger.warn(`late start reminder for ${userId} failed: ${(err as Error).message}`);
    }
  }

  /** Keeps the reason on the session Start Day just opened (best effort). */
  async keep(sessionId: string, reason: string, now: Date): Promise<void> {
    try {
      await this.sessions.setLateReason(sessionId, reason, now);
    } catch (err) {
      this.logger.warn(`late reason for session ${sessionId} not kept: ${(err as Error).message}`);
    }
  }

  /**
   * POST /workday/me/late-reason: the reason for a late start, added (or corrected)
   * in the portal. Today's working day unless `date` names an earlier one; a month
   * locked for payroll keeps what it had (409 MONTH_LOCKED).
   */
  async addReason(
    me: AuthenticatedUser,
    dto: { date?: string; reason: string },
    now: Date,
  ): Promise<{ date: string; lateStart: LateStartDetail }> {
    const person = await this.people.findById(me.id);
    if (!person) throw new NotFoundError('User not found');
    const date = dto.date ?? (await this.dayKeys.dayKeyAt(me.id, now));
    const [sessions, pc] = await Promise.all([
      this.sessions.listForUserOnDate(me.id, date),
      this.plans.context([person]),
    ]);
    const settings = pc.settingsOf(person.companyId);
    const first = [...sessions].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())[0];
    if (!first) {
      throw new ConflictError('That day has no Start Day, so there is no late start.', 'NOT_LATE');
    }
    const plan = pc.plan(person, date);
    const shift = plan.shift;
    const leave = await this.leaveOf(person.id, date);
    const shiftStart =
      shift && plan.isWorkingDay && !leave?.full ? this.markOf(shift, date, leave) : null;
    const detail = lateStartDetail({
      first,
      shiftStart,
      graceMin: settings.lateStartGraceMin,
      requireReason: settings.requireLateStartReason,
      exempt: isExempt(me.role),
    });
    if (!detail) {
      throw new ConflictError(
        `That day started within ${settings.lateStartGraceMin} minutes of the shift start. No reason is needed.`,
        'NOT_LATE',
      );
    }
    const minChars = shift?.reasonMinChars ?? DEFAULT_REASON_MIN_CHARS;
    const reason = clean(dto.reason);
    if (!reason || !(await this.presets.accepts('LATE_DAY_START', reason, minChars))) {
      throw new UnprocessableError(
        `Say why you started late (at least ${minChars} characters).`,
        'REASON_REQUIRED',
      ).withDetails({ minChars });
    }
    if ((reason as string).length > LATE_REASON_MAX_CHARS) {
      throw new UnprocessableError(
        `Keep the reason under ${LATE_REASON_MAX_CHARS} characters.`,
        'REASON_TOO_LONG',
      ).withDetails({ maxChars: LATE_REASON_MAX_CHARS });
    }
    const saved = await this.sessions.setLateReason(first.id, reason as string, now);
    if (!saved) throw new NotFoundError('That day could not be found.');
    return {
      date,
      lateStart: lateStartDetail({
        first: saved,
        shiftStart,
        graceMin: settings.lateStartGraceMin,
        requireReason: settings.requireLateStartReason,
        exempt: me.role === Role.SUPER_ADMIN,
      }) as LateStartDetail,
    };
  }
}
