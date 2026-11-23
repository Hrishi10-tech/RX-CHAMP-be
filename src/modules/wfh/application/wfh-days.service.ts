import { Inject, Injectable } from '@nestjs/common';
import { addDaysToKey, hmToMinutes, isValidHm } from '@shared/utils/timezone';
import { LeaveDaysService } from '@modules/leave/application/leave-days.service';
import { LeavePeopleService } from '@modules/leave/application/leave-people.service';
import { leaveOn } from '@modules/leave/domain/day-leave';
import { FULL_MASK, maskOf, unitsOfMask } from '@modules/leave/domain/leave.types';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import { ShiftRecord } from '@modules/shifts/domain/shift.types';
import { expectedSecOf, NO_SHIFT_EXPECTED_SEC } from '@modules/worktime/domain/attendance';
import { capSecOf, scheduleCovers, WfhByDay, WfhDay, WfhScheduleRecord } from '../domain/wfh';
import { CreditBasis, wfhPolicyFromStored } from '../domain/wfh-policy';
import { WFH_REPOSITORY, WfhRepository } from '../domain/wfh.repository';
import { WfhPolicyService } from './wfh-policy.service';

export type { WfhByDay, WfhDay } from '../domain/wfh';
export { NO_WFH, wfhOn } from '../domain/wfh';

/** Seconds a full day from home can credit on this shift (3.5). */
export function basisSecOf(shift: ShiftRecord | null, basis: CreditBasis): number {
  if (!shift || !isValidHm(shift.start) || !isValidHm(shift.end)) return NO_SHIFT_EXPECTED_SEC;
  if (basis === 'EXPECTED') return expectedSecOf(shift);
  let minutes = hmToMinutes(shift.end) - hmToMinutes(shift.start);
  if (minutes <= 0) minutes += 1440;
  return minutes * 60;
}

/**
 * Work from home as other modules read it (3.5): Team today, the working day, the
 * credit cap, reports and the month lock. Requests and schedules together; days
 * off are never work from home (4.0: the organisation calendar decides, with the
 * person's or department's own week), and approved leave takes its quarters out.
 * The credit cap follows each person's organisation's policy. Read-only.
 */
@Injectable()
export class WfhDaysService {
  constructor(
    @Inject(WFH_REPOSITORY) private readonly repo: WfhRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
    private readonly leaveDays: LeaveDaysService,
    private readonly policy: WfhPolicyService,
    private readonly calendar: LeavePeopleService,
  ) {}

  async byDay(userIds: string[], from: string, to: string): Promise<WfhByDay> {
    const out: WfhByDay = new Map();
    const ids = [...new Set(userIds)];
    if (!ids.length || from > to) return out;
    const [held, schedules] = await Promise.all([
      this.repo.heldDaysOf(ids, from, to),
      this.repo.schedulesBetween(ids, from, to),
    ]);
    if (!held.length && !schedules.length) return out;

    const who = [...new Set([...held.map((h) => h.userId), ...schedules.map((s) => s.userId)])];
    const [people, ctx, leave] = await Promise.all([
      this.people.findAnyByIds(who),
      this.days.context(who),
      this.leaveDays.byDay(who, from, to),
    ]);
    const [works, policyOf] = await Promise.all([
      this.calendar.workdays(people),
      this.policy.forPeople(people),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));

    const raw = new Map<string, { request: number; pending: number; schedule: number }>();
    const slot = (userId: string, date: string) => {
      const k = `${userId}|${date}`;
      let v = raw.get(k);
      if (!v) raw.set(k, (v = { request: 0, pending: 0, schedule: 0 }));
      return v;
    };
    for (const h of held) {
      if (h.status === 'APPROVED') slot(h.userId, h.date).request |= h.mask;
      else slot(h.userId, h.date).pending |= h.mask;
    }
    const byUser = new Map<string, WfhScheduleRecord[]>();
    for (const s of schedules) byUser.set(s.userId, [...(byUser.get(s.userId) ?? []), s]);
    for (const [userId, list] of byUser) {
      const person = byId.get(userId);
      if (!person) continue;
      for (let d = from; d <= to; d = addDaysToKey(d, 1)) {
        const hits = list.filter((s) => scheduleCovers(s, d));
        if (!hits.length) continue;
        // A scheduled day that is not a working day is no work from home.
        if (!works(person, d)) continue;
        for (const s of hits) slot(userId, d).schedule |= maskOf(s.kind, s.part);
      }
    }

    for (const [k, v] of raw) {
      const [userId, date] = k.split('|');
      const person = byId.get(userId);
      const onLeave = leaveOn(leave, userId, date).mask;
      const mask = (v.request | v.schedule) & FULL_MASK & ~onLeave;
      const pendingMask = v.pending & FULL_MASK & ~onLeave & ~mask;
      if (!mask && !pendingMask) continue;
      const shift = person ? this.days.resolveWith(ctx, person, date).shift : null;
      const day: WfhDay = {
        mask,
        units: unitsOfMask(mask),
        pendingMask,
        source:
          v.request && v.schedule ? 'BOTH' : v.request ? 'REQUEST' : v.schedule ? 'SCHEDULE' : null,
        capSec: capSecOf(
          basisSecOf(shift, (person ? policyOf(person) : wfhPolicyFromStored(null)).creditBasis),
          mask,
        ),
      };
      let days = out.get(userId);
      if (!days) out.set(userId, (days = new Map()));
      days.set(date, day);
    }
    return out;
  }

  /** Pending requests with a day in this month (a month lock waits for them). */
  pendingInMonth(month: string, userIds?: string[]): Promise<number> {
    return this.repo.pendingInMonth(month, userIds);
  }
}
