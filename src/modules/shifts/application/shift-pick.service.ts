import { Inject, Injectable, Logger } from '@nestjs/common';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '../domain/shift-people.reader';
import { pickShiftByTime, PickedShift } from '../domain/shift-pick';
import { SHIFT_REPOSITORY, ShiftRepository } from '../domain/shift.repository';
import { departmentKey, ShiftRecord } from '../domain/shift.types';
import { BreakDayService } from './break-day.service';

/**
 * 4.1: a department can run several shifts (its main one plus extra ones). At Start
 * Day a person who gets the department's shift is given the one that is on (in a
 * gap, the next one), stored as a one-day personal assignment so breaks, reports,
 * auto-close and the shared-computer handover all follow it. Picked once a day; a
 * person's own shift (set by an Admin) always wins.
 */
@Injectable()
export class ShiftPickService {
  private readonly logger = new Logger(ShiftPickService.name);

  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
  ) {}

  /** Picks and stores the shift for a Start Day at `at`; null when nothing was picked. */
  async pickOnStartDay(userId: string, at: Date): Promise<PickedShift | null> {
    const person = await this.people.findById(userId);
    const key = departmentKey(person?.department ?? null);
    if (!person || !key) return null;
    const extraIds = (await this.shifts.listDepartmentShifts())
      .filter(
        (d) =>
          d.departmentKey === key && (d.companyId === null || d.companyId === person.companyId),
      )
      .map((d) => d.shiftId);
    if (!extraIds.length) return null;
    // Several shifts only count in a shared-computer department.
    const shared = this.people.sharedComputerKeys
      ? await this.people.sharedComputerKeys(person.companyId ?? undefined)
      : new Set<string>();
    if (!shared.has(`${person.companyId}|${key}`)) return null;

    const tz = appTimezone();
    const today = dateKeyInZone(at, tz);
    const ctx = await this.days.context([userId]);
    const resolved = this.days.resolveWith(ctx, person, today);
    // Their own shift (or today's pick, already made) stands.
    if (resolved.source === 'OVERRIDE') return null;

    const options: ShiftRecord[] = [];
    if (resolved.source === 'DEPARTMENT' && resolved.shift) options.push(resolved.shift);
    for (const id of extraIds) {
      const s = ctx.shiftsById.get(id);
      if (s && !options.some((o) => o.id === s.id)) options.push(s);
    }
    const picked = pickShiftByTime(options, at, today, tz);
    if (!picked) return null;
    // Yesterday's overnight shift: only if that day has no shift of its own yet.
    if (
      picked.dateKey !== today &&
      this.days.resolveWith(ctx, person, picked.dateKey).source === 'OVERRIDE'
    ) {
      return null;
    }

    await this.shifts.applyAssignments([
      {
        target: 'USER',
        companyId: person.companyId,
        department: null,
        departmentKey: null,
        userId,
        shiftId: picked.shift.id,
        effectiveFrom: picked.dateKey,
        effectiveTo: picked.dateKey,
        createdById: null,
        autoPicked: true,
      },
    ]);
    this.days.invalidate();
    this.logger.log(
      `shift picked by Start Day time: ${userId} ${picked.dateKey} ${picked.shift.name}`,
    );
    return picked;
  }
}
