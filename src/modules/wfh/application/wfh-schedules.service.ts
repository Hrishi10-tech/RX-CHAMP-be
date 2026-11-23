import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { allOrgsInView } from '@shared/tenancy';
import { addDaysToKey, appTimezone, dateKeyInZone, isValidDateKey } from '@shared/utils/timezone';
import { fullName, LeavePeopleService } from '@modules/leave/application/leave-people.service';
import { leaveDay } from '@modules/leave/domain/request-rules';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { checkKindPart, scheduleCovers, scheduleLabel, WfhScheduleRecord } from '../domain/wfh';
import { WFH_NOTICE, wfhScheduledCopy } from '../domain/wfh-copy';
import { WFH_REPOSITORY, WfhRepository } from '../domain/wfh.repository';
import { WfhChangedEvent } from './wfh-requests.service';
import { WfhScheduleView } from './wfh.views';

export interface ScheduleInput {
  userId: string;
  weekdays: unknown;
  weeks?: unknown;
  kind: unknown;
  part?: unknown;
  fromDate: unknown;
  toDate?: unknown;
  note?: unknown;
}

const NOTE_MAX = 300;

/** Who sets schedules (4.0): department managers, the organisation admin, above them. */
const SCHEDULERS: string[] = [Role.MANAGER, Role.ADMIN, Role.SUPER_MANAGER, Role.SUPER_ADMIN];
const HORIZON_DAYS = 120;

/**
 * Work-from-home schedules (3.5): set by whoever may see the person among the
 * managers of their department, the organisation admin, the Super Manager and the
 * Super Admins (4.0). A schedule that has begun is never rewritten: a change ends it
 * and starts a new one, so the days already worked keep what they were.
 */
@Injectable()
export class WfhSchedulesService {
  private readonly logger = new Logger(WfhSchedulesService.name);

  constructor(
    @Inject(WFH_REPOSITORY) private readonly repo: WfhRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly people: LeavePeopleService,
  ) {}

  private today(now: Date): string {
    return dateKeyInZone(now, appTimezone());
  }

  /** Whether the caller may set this person's schedule (a Super Admin their own too). */
  private maySchedule(me: AuthenticatedUser, target: ShiftPerson): boolean {
    if (!SCHEDULERS.includes(me.role)) return false;
    if (target.id === me.id) return me.role === Role.SUPER_ADMIN;
    return this.people.canSee(me, target);
  }

  /** Who may set someone's schedule: anyone who sees them among the schedulers. */
  private async assertMaySchedule(me: AuthenticatedUser, userId: string): Promise<ShiftPerson> {
    const target = (await this.people.any([userId])).get(userId);
    if (!target || !target.active) throw new NotFoundError('Unknown person');
    if (!SCHEDULERS.includes(me.role))
      throw new ForbiddenError('Only managers can set a work-from-home schedule.');
    if (target.id === me.id && me.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenError(
        "Your own schedule is set by your department's manager or the organisation admin.",
      );
    }
    // 4.0: outside the caller's organisation or departments the person does not exist for them.
    if (!this.maySchedule(me, target)) throw new NotFoundError('Unknown person');
    return target;
  }

  private check(input: ScheduleInput, today: string) {
    const weekdays = Array.isArray(input.weekdays) ? [...new Set(input.weekdays as unknown[])] : [];
    if (
      !weekdays.length ||
      weekdays.some((d) => !Number.isInteger(d) || (d as number) < 1 || (d as number) > 7)
    ) {
      throw new ValidationError(
        'Pick at least one weekday (1 = Monday to 7 = Sunday).',
      ).withDetails({ field: 'weekdays' });
    }
    const weeksRaw = input.weeks === undefined || input.weeks === null ? [] : input.weeks;
    const weeks = Array.isArray(weeksRaw) ? [...new Set(weeksRaw as unknown[])] : null;
    if (
      !weeks ||
      weeks.some((w) => !Number.isInteger(w) || (w as number) < 1 || (w as number) > 5)
    ) {
      throw new ValidationError(
        'Weeks of the month are 1 to 5 (leave empty for every week).',
      ).withDetails({ field: 'weeks' });
    }
    const kp = checkKindPart(input.kind, input.part);
    if (!kp.ok) throw new ValidationError(kp.message).withDetails({ field: kp.field });
    if (typeof input.fromDate !== 'string' || !isValidDateKey(input.fromDate)) {
      throw new ValidationError('The first day must be a real day (YYYY-MM-DD).').withDetails({
        field: 'fromDate',
      });
    }
    if (input.fromDate < today) {
      throw new ValidationError('A schedule starts today or later.').withDetails({
        field: 'fromDate',
      });
    }
    let toDate: string | null = null;
    if (input.toDate !== undefined && input.toDate !== null && input.toDate !== '') {
      if (typeof input.toDate !== 'string' || !isValidDateKey(input.toDate)) {
        throw new ValidationError('The last day must be a real day (YYYY-MM-DD).').withDetails({
          field: 'toDate',
        });
      }
      if (input.toDate < input.fromDate) {
        throw new ValidationError('The last day is before the first day.').withDetails({
          field: 'toDate',
        });
      }
      toDate = input.toDate;
    }
    const note = typeof input.note === 'string' ? input.note.trim().replace(/\s+/g, ' ') : '';
    if (note.length > NOTE_MAX) {
      throw new ValidationError(`A note is at most ${NOTE_MAX} characters.`).withDetails({
        field: 'note',
      });
    }
    return {
      weekdays: (weekdays as number[]).sort((a, b) => a - b),
      weeks: (weeks as number[]).sort((a, b) => a - b),
      kind: kp.kind,
      part: kp.part,
      fromDate: input.fromDate,
      toDate,
      note,
    };
  }

  /** Another schedule of the person covering the same weekday in the same weeks and dates. */
  private async assertNoClash(
    userId: string,
    s: { weekdays: number[]; weeks: number[]; fromDate: string; toDate: string | null },
    exceptId?: string,
  ): Promise<void> {
    const others = (
      await this.repo.schedulesBetween([userId], s.fromDate, s.toDate ?? '9999-12-31')
    ).filter((o) => o.id !== exceptId);
    for (const o of others) {
      const sameDay = o.weekdays.some((d) => s.weekdays.includes(d));
      const sameWeek =
        !o.weeks.length || !s.weeks.length || o.weeks.some((w) => s.weeks.includes(w));
      if (sameDay && sameWeek) {
        throw new ConflictError(
          `This overlaps another schedule of theirs (${scheduleLabel(o).toLowerCase()}, from ${leaveDay(o.fromDate)}). ` +
            'Change or end that one first.',
          'WFH_SCHEDULE_OVERLAP',
        ).withDetails({ scheduleId: o.id });
      }
    }
  }

  async create(me: AuthenticatedUser, input: ScheduleInput, now: Date): Promise<WfhScheduleView> {
    const target = await this.assertMaySchedule(me, input.userId);
    const s = this.check(input, this.today(now));
    await this.assertNoClash(target.id, s);
    const saved = await this.repo.insertSchedule({
      userId: target.id,
      ...s,
      skipDates: [],
      createdById: me.id,
    });
    this.logger.log(
      `wfh schedule ${saved.id} for ${target.id} by ${me.id}: ${scheduleLabel(saved)}`,
    );
    await this.notify(me, saved, 'SET');
    return (await this.views(me, [saved], now))[0];
  }

  /**
   * A change. Not begun: replaced. Begun: ended yesterday and a new one starts from
   * today (or the new first day, if later).
   */
  async update(
    me: AuthenticatedUser,
    id: string,
    input: Omit<ScheduleInput, 'userId'>,
    now: Date,
  ): Promise<WfhScheduleView> {
    const cur = await this.repo.findSchedule(id);
    if (!cur) throw new NotFoundError('Unknown schedule');
    await this.assertMaySchedule(me, cur.userId);
    const today = this.today(now);
    if (cur.toDate && cur.toDate < today) {
      throw new ConflictError('This schedule has ended. Set a new one instead.', 'SCHEDULE_ENDED');
    }
    if (cur.fromDate > today) {
      // Not begun: replaced as asked.
      const s = this.check({ ...input, userId: cur.userId }, today);
      await this.assertNoClash(cur.userId, s, cur.id);
      await this.repo.deleteSchedule(cur.id);
      const saved = await this.repo.insertSchedule({
        userId: cur.userId,
        ...s,
        skipDates: cur.skipDates.filter((d) => d >= s.fromDate),
        createdById: me.id,
      });
      await this.notify(me, saved, 'CHANGED');
      return (await this.views(me, [saved], now))[0];
    }
    // Begun: the old one ends (today stays as it was when it covers today) and a new
    // one starts on the first free day, or later if asked.
    const keepToday = scheduleCovers(cur, today);
    const earliest = keepToday ? addDaysToKey(today, 1) : today;
    const asked =
      typeof input.fromDate === 'string' && isValidDateKey(input.fromDate)
        ? input.fromDate
        : earliest;
    const s = this.check(
      { ...input, userId: cur.userId, fromDate: asked > earliest ? asked : earliest },
      today,
    );
    await this.assertNoClash(cur.userId, s, cur.id);
    await this.repo.updateSchedule(cur.id, {
      toDate: keepToday ? today : addDaysToKey(today, -1),
      updatedById: me.id,
    });
    const saved = await this.repo.insertSchedule({
      userId: cur.userId,
      ...s,
      skipDates: cur.skipDates.filter((d) => d >= s.fromDate),
      createdById: me.id,
    });
    await this.notify(me, saved, 'CHANGED');
    return (await this.views(me, [saved], now))[0];
  }

  /** End a schedule: nothing after today (a schedule not begun yet is removed). */
  async end(
    me: AuthenticatedUser,
    id: string,
    now: Date,
  ): Promise<{ ended: true; removed: boolean }> {
    const cur = await this.repo.findSchedule(id);
    if (!cur) throw new NotFoundError('Unknown schedule');
    await this.assertMaySchedule(me, cur.userId);
    const today = this.today(now);
    let removed = false;
    if (cur.fromDate > today) {
      removed = await this.repo.deleteSchedule(cur.id);
    } else if (!cur.toDate || cur.toDate > today) {
      await this.repo.updateSchedule(cur.id, { toDate: today, updatedById: me.id });
    }
    await this.notify(me, { ...cur, toDate: today }, 'ENDED');
    return { ended: true, removed };
  }

  /** Leave one day out of a schedule, or put it back (today or later). */
  async skip(
    me: AuthenticatedUser,
    id: string,
    date: string,
    skip: boolean,
    now: Date,
  ): Promise<WfhScheduleView> {
    const cur = await this.repo.findSchedule(id);
    if (!cur) throw new NotFoundError('Unknown schedule');
    await this.assertMaySchedule(me, cur.userId);
    if (!isValidDateKey(date))
      throw new ValidationError('Pick a real day (YYYY-MM-DD).').withDetails({ field: 'date' });
    if (date < this.today(now)) {
      throw new ValidationError('Only today or a later day can be left out.').withDetails({
        field: 'date',
      });
    }
    const skipDates = skip
      ? [...new Set([...cur.skipDates, date])].sort()
      : cur.skipDates.filter((d) => d !== date);
    const saved = await this.repo.updateSchedule(cur.id, { skipDates, updatedById: me.id });
    await this.changed(saved.userId, date, date);
    return (await this.views(me, [saved], now))[0];
  }

  /** GET /wfh/schedules: in the caller's scope (a person sees theirs through /wfh/me). */
  async list(
    me: AuthenticatedUser,
    q: { userId?: string; companyId?: string; includeEnded?: boolean },
    now: Date,
  ): Promise<WfhScheduleView[]> {
    const scope = await this.people.scopeIds(me, {
      companyId: allOrgsInView(me) ? q.companyId : undefined,
    });
    if (q.userId && scope && !scope.includes(q.userId)) {
      throw new ForbiddenError('That person is not in your team.');
    }
    const today = this.today(now);
    const ids = q.userId ? [q.userId] : scope;
    const rows = await this.repo.schedulesBetween(
      ids,
      q.includeEnded ? '0000-01-01' : today,
      '9999-12-31',
    );
    return this.views(me, rows, now);
  }

  /** The person's own schedules (running or ahead). */
  async mine(me: AuthenticatedUser, now: Date): Promise<WfhScheduleView[]> {
    const rows = await this.repo.schedulesBetween([me.id], this.today(now), '9999-12-31');
    return this.views(me, rows, now);
  }

  async views(
    me: AuthenticatedUser,
    rows: WfhScheduleRecord[],
    now: Date,
  ): Promise<WfhScheduleView[]> {
    if (!rows.length) return [];
    const today = this.today(now);
    const people = await this.people.any(rows.flatMap((r) => [r.userId, r.createdById]));
    const works = await this.people.workdays([...people.values()]);
    return rows.map((r) => {
      const person = people.get(r.userId);
      const next: { date: string; label: string }[] = [];
      if (person) {
        for (
          let d = r.fromDate > today ? r.fromDate : today, n = 0;
          n < HORIZON_DAYS && next.length < 5;
          n++
        ) {
          if (r.toDate && d > r.toDate) break;
          if (scheduleCovers(r, d) && works(person, d)) next.push({ date: d, label: leaveDay(d) });
          d = addDaysToKey(d, 1);
        }
      }
      const state =
        r.toDate && r.toDate < today ? 'ENDED' : r.fromDate > today ? 'UPCOMING' : 'ACTIVE';
      const mayEdit = state !== 'ENDED' && !!person && this.maySchedule(me, person);
      return {
        id: r.id,
        userId: r.userId,
        userName: fullName(person),
        avatarId: person?.avatarId ?? null,
        department: person?.department ?? null,
        companyName: person?.companyName ?? null,
        weekdays: r.weekdays,
        weeks: r.weeks,
        kind: r.kind,
        part: r.part,
        label: scheduleLabel(r),
        fromDate: r.fromDate,
        toDate: r.toDate,
        skipDates: r.skipDates,
        note: r.note,
        state,
        next,
        createdByName: fullName(people.get(r.createdById)),
        updatedAt: r.updatedAt.toISOString(),
        can: { edit: mayEdit },
      };
    });
  }

  private async notify(
    me: AuthenticatedUser,
    s: WfhScheduleRecord,
    change: 'SET' | 'CHANGED' | 'ENDED',
  ): Promise<void> {
    await this.changed(s.userId, s.fromDate, s.toDate ?? s.fromDate);
    if (s.userId === me.id) return;
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    const copy = wfhScheduledCopy({ byName, schedule: s, change });
    try {
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([s.userId], WFH_NOTICE.WFH_SCHEDULED, copy.title, copy.body, me.id),
      );
    } catch (err) {
      this.logger.warn(`wfh schedule notice failed: ${(err as Error).message}`);
    }
  }

  private async changed(userId: string, startDate: string, endDate: string): Promise<void> {
    await this.events
      .publish(WfhChangedEvent.eventName, new WfhChangedEvent(userId, startDate, endDate))
      .catch(() => undefined);
  }
}
