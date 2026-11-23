import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { WorkdayChangedEvent } from '@shared/events/workday-changed.event';
import { appTimezone, startOfDayInZone, time12InZone } from '@shared/utils/timezone';
import { DayEndedEvent } from '@modules/activity/domain/events/day-ended.event';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService, ResolutionContext } from '@modules/shifts/application/break-day.service';
import { personName } from '@modules/shifts/application/break-events.service';
import { shiftBounds } from '@modules/shifts/domain/break-schedule';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import { LateStartService } from '@modules/worktime/application/late-start.service';
import { WorkSessionsService } from '@modules/worktime/application/work-sessions.service';
import { latestEndOf } from '@modules/worktime/domain/auto-close';
import { leaveDay } from '@modules/leave/domain/request-rules';
import {
  BIOMETRIC_REPOSITORY,
  BiometricRepository,
  PunchRecord,
} from '../domain/biometric.repository';
import { DayPlan, planBiometricDay } from '../domain/punch';
import { BiometricSettingsService } from './biometric-settings.service';

export const BIOMETRIC_NOTICE = {
  BIOMETRIC_NO_CHECKOUT: 'BIOMETRIC_NO_CHECKOUT',
} as const;

/** The plan of a day from its stored punches (voided and locked-out ones left out). */
export function validPunches(
  list: PunchRecord[],
): { at: Date; direction: PunchRecord['direction'] }[] {
  return list
    .filter((p) => !p.voidedAt && !p.lockedOut)
    .map((p) => ({ at: p.punchedAt, direction: p.direction }));
}

/**
 * Biometric days (3.5): a biometric person's work sessions of a day are worked out
 * from that day's punches, again every time a punch arrives, is added by hand or
 * voided, and when an open day reaches its cutoff (the 10-minute job). Agent staff's
 * punches are kept for the record and never change their day. 4.0: the person's
 * organisation's biometric settings, day settings and month locks apply.
 */
@Injectable()
export class BiometricDaysService {
  private readonly logger = new Logger(BiometricDaysService.name);

  constructor(
    @Inject(BIOMETRIC_REPOSITORY) private readonly repo: BiometricRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly days: BreakDayService,
    private readonly settings: BiometricSettingsService,
    private readonly appSettings: AppSettingsService,
    private readonly lateStart: LateStartService,
    private readonly workSessions: WorkSessionsService,
  ) {}

  /** Whether punches shape this person's day on `dayKey` (4.0: people of an organisation only). */
  static shapes(person: ShiftPerson | null | undefined, dayKey: string): boolean {
    if (!person || !person.companyId || person.attendanceSource !== 'BIOMETRIC') return false;
    return !person.attendanceSourceFrom || dayKey >= person.attendanceSourceFrom;
  }

  /** The plan of one day, without saving it (also the day views and tests). */
  async planDay(
    person: ShiftPerson,
    dayKey: string,
    punches: PunchRecord[],
    now: Date,
    ctx?: ResolutionContext,
    opts: { forceClose?: boolean } = {},
  ): Promise<DayPlan> {
    const companyId = person.companyId ?? '';
    const [s, org, context] = await Promise.all([
      this.settings.get(companyId),
      this.appSettings.get(person.companyId),
      ctx ? Promise.resolve(ctx) : this.days.context([person.id]),
    ]);
    const valid = validPunches(punches);
    const shift = this.days.resolveWith(context, person, dayKey).shift;
    const tz = appTimezone();
    const shiftEnd = shift ? shiftBounds(shift, dayKey, tz).end : null;
    const first = valid.length
      ? valid.reduce((m, p) => (p.at < m ? p.at : m), valid[0].at)
      : startOfDayInZone(dayKey, tz);
    const cutoff = opts.forceClose
      ? new Date(0)
      : latestEndOf({
          startedAt: first,
          shiftEnd,
          autoCloseAfterShiftEndMin: org.autoCloseAfterShiftEndMin,
        });
    return planBiometricDay(valid, {
      gapRule: s.gapRule,
      missingCheckout: s.missingCheckout,
      duplicateWindowSec: s.duplicateWindowSec,
      cutoff,
      shiftEnd,
      now,
    });
  }

  /** Works these days of one person out again from their punches. Returns days changed. */
  async rebuild(userId: string, dayKeys: string[], now: Date): Promise<number> {
    const person = (await this.people.findAnyByIds([userId]))[0];
    const wanted = [...new Set(dayKeys)]
      .filter((d) => BiometricDaysService.shapes(person, d))
      .sort();
    if (!person?.companyId || !wanted.length) return 0;
    const locked = await this.repo.lockedMonths(
      person.companyId,
      wanted.map((d) => d.slice(0, 7)),
    );
    const open = wanted.filter((d) => !locked.has(d.slice(0, 7)));
    if (!open.length) return 0;
    // Work from home on the phone left running past its latest end is ended first (at
    // the shift end, with its notice), so it neither holds this day open nor closes it.
    await this.workSessions.autoCloseIfStale(userId, now).catch(() => false);
    const ctx = await this.days.context([userId]);
    const all = await this.repo.punchesOfDays(userId, open);
    let changed = 0;
    for (const dayKey of open) {
      try {
        const punches = all.filter((p) => p.dayKey === dayKey);
        const plan = await this.planDay(person, dayKey, punches, now, ctx);
        const valid = validPunches(punches);
        const last = valid.length ? valid[valid.length - 1].at : null;
        // Asked before the day is saved: only a day's first start can be a late one.
        const late = plan.sessions.length
          ? await this.lateStart
              .lateFirstStart(person, plan.sessions[0].startedAt)
              .catch(() => null)
          : null;
        const res = await this.repo.replaceDay(userId, dayKey, plan.sessions, last);
        if (!res.changed) continue;
        changed += 1;
        await this.announce(
          person,
          dayKey,
          plan,
          res,
          now,
          late && late.date === dayKey ? late : null,
        );
      } catch (err) {
        this.logger.warn(
          `biometric day ${dayKey} of ${userId} not rebuilt: ${(err as Error).message}`,
        );
      }
    }
    return changed;
  }

  /** The 10-minute job: open biometric days past their cutoff close (no check-out). */
  async closeDue(now: Date): Promise<number> {
    const open = await this.repo.openDays();
    if (!open.length) return 0;
    const people = new Map(
      (await this.people.findAnyByIds([...new Set(open.map((o) => o.userId))])).map((p) => [
        p.id,
        p,
      ]),
    );
    let closed = 0;
    for (const o of open) {
      // Someone moved off biometric with a day still open: it closes at its last punch.
      if (!BiometricDaysService.shapes(people.get(o.userId), o.date)) {
        closed += await this.closeOpen(o.userId, now);
        continue;
      }
      closed += await this.rebuild(o.userId, [o.date], now);
    }
    if (closed) this.logger.log(`closed ${closed} biometric day(s) with no check-out`);
    return closed;
  }

  /** Closes the person's open biometric days at their last punch, now (a change of source). */
  async closeOpen(userId: string, now: Date): Promise<number> {
    const open = (await this.repo.openDays()).filter((o) => o.userId === userId);
    const person = (await this.people.findAnyByIds([userId]))[0];
    if (!person) return 0;
    let closed = 0;
    for (const o of open) {
      const punches = await this.repo.punchesOfDays(userId, [o.date]);
      const plan = await this.planDay(person, o.date, punches, now, undefined, {
        forceClose: true,
      });
      const valid = validPunches(punches);
      const res = await this.repo.replaceDay(
        userId,
        o.date,
        plan.sessions,
        valid.length ? valid[valid.length - 1].at : null,
      );
      if (res.changed) {
        closed += 1;
        await this.events
          .publish(
            WorkdayChangedEvent.eventName,
            new WorkdayChangedEvent([userId], 'BIOMETRIC', now.toISOString()),
          )
          .catch(() => undefined);
      }
    }
    return closed;
  }

  /** Who hears about a person's day: their department's managers, else the organisation admins. */
  private async overseersOf(person: ShiftPerson): Promise<string[]> {
    const managers =
      person.role === 'USER' && person.departmentId
        ? await this.people.listDepartmentManagerIds(person.departmentId)
        : [];
    if (managers.length) return managers;
    return person.companyId ? this.people.listOrgAdminIds(person.companyId) : [];
  }

  private async announce(
    person: ShiftPerson,
    dayKey: string,
    plan: DayPlan,
    res: { wasOpen: boolean; open: boolean; wasEmpty: boolean; newlyEnded: boolean },
    now: Date,
    late: Awaited<ReturnType<LateStartService['lateFirstStart']>>,
  ): Promise<void> {
    const name = personName(person);
    try {
      await this.events.publish(
        WorkdayChangedEvent.eventName,
        new WorkdayChangedEvent([person.id], 'BIOMETRIC', now.toISOString()),
      );
      // The first punch of the day: a late start asks for the reason, as Start Day does.
      if (res.wasEmpty && late) await this.lateStart.remind(person.id, late);
      if (res.newlyEnded) {
        const end = plan.sessions.reduce<Date | null>(
          (m, s) => (s.endedAt && (!m || s.endedAt > m) ? s.endedAt : m),
          null,
        );
        if (end) {
          await this.events.publish(
            DayEndedEvent.eventName,
            new DayEndedEvent(person.id, name, person.managerId, dayKey, end),
          );
        }
      }
      // Closed with no check-out now: the day was running, or its punches came after the cutoff.
      if (plan.checkoutMissing && !res.open && (res.wasOpen || res.wasEmpty)) {
        const at = time12InZone(
          plan.sessions[plan.sessions.length - 1].endedAt ?? now,
          appTimezone(),
        );
        const day = leaveDay(dayKey);
        await this.events.publish(
          NoticeEvent.eventName,
          new NoticeEvent(
            [person.id],
            BIOMETRIC_NOTICE.BIOMETRIC_NO_CHECKOUT,
            `No check-out on ${day}`,
            `No check-out was recorded on ${day}, so the day was closed at ${at}. If you left later, tell your manager so the missing punch can be added.`,
            null,
          ),
        );
        // 4.0: the managers of their department, else the organisation's admins.
        const to = (await this.overseersOf(person)).filter((id) => id !== person.id);
        if (to.length) {
          await this.events.publish(
            NoticeEvent.eventName,
            new NoticeEvent(
              to,
              BIOMETRIC_NOTICE.BIOMETRIC_NO_CHECKOUT,
              `${name}: no check-out on ${day}`,
              `${name} has no check-out on ${day}, so the day was closed at ${at}. The organisation admin can add the missing punch in Attendance.`,
              person.id,
            ),
          );
        }
      }
    } catch (err) {
      this.logger.warn(`biometric notices for ${person.id} failed: ${(err as Error).message}`);
    }
  }
}
