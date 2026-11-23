import { Inject, Injectable } from '@nestjs/common';
import { LEAVE_REPOSITORY, LeaveRepository } from '../domain/leave.repository';
import { FULL_MASK, unitsOfMask } from '../domain/leave.types';
import { LeaveByDay, NO_LEAVE } from '../domain/day-leave';

export type { DayLeave, LeaveByDay } from '../domain/day-leave';
export { leaveOn, NO_LEAVE } from '../domain/day-leave';

/**
 * Leave as other modules read it (3.4): attendance, Team today, late starts,
 * reports, the month lock. Read-only.
 */
@Injectable()
export class LeaveDaysService {
  constructor(@Inject(LEAVE_REPOSITORY) private readonly repo: LeaveRepository) {}

  async byDay(userIds: string[], from: string, to: string): Promise<LeaveByDay> {
    const out: LeaveByDay = new Map();
    if (!userIds.length || from > to) return out;
    const rows = await this.repo.heldDaysOf(userIds, from, to);
    for (const r of rows) {
      let days = out.get(r.userId);
      if (!days) out.set(r.userId, (days = new Map()));
      const cur = { ...(days.get(r.date) ?? NO_LEAVE) };
      if (r.status === 'APPROVED') {
        cur.mask |= r.mask;
        if (r.category === 'CLSL') cur.clslUnits += r.units;
        else if (r.category === 'ELPL') cur.elplUnits += r.units;
        else cur.compOffUnits += r.units;
      } else {
        cur.pendingMask |= r.mask;
      }
      cur.units = unitsOfMask(cur.mask);
      cur.full = (cur.mask & FULL_MASK) === FULL_MASK;
      days.set(r.date, cur);
    }
    return out;
  }

  /** Pending requests with a day in this month (a month lock waits for them). */
  pendingInMonth(month: string): Promise<number> {
    return this.repo.pendingInMonth(month);
  }
}
