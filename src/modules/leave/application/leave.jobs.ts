import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { addDaysToKey, appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import { leaveUpdatedCopy, LEAVE_NOTICE } from '../domain/leave-copy';
import { LEAVE_REPOSITORY, LeaveRepository, LeaveRequestRecord } from '../domain/leave.repository';
import { kindLabel } from '../domain/leave.types';
import { LeaveAccountsService } from './leave-accounts.service';
import { LeavePeopleService } from './leave-people.service';
import { LeaveChangedEvent } from './leave-requests.service';

/** How far back a day off added later still gives leave back (two months, like adjustments). */
export const REPRICE_BACK_DAYS = 62;

/** Calendar changes in a burst (a bulk assignment) are repriced once. */
const REPRICE_DEBOUNCE_MS = 3_000;

/**
 * Leave housekeeping (3.4):
 * - every night, this year's accounts are opened for everyone (1 January grants
 *   the new year; a new joiner gets theirs the next night at the latest);
 * - when a holiday, a department calendar or a shift changes, a day of pending or
 *   approved leave that is no longer a working day is given back.
 */
@Injectable()
export class LeaveJobs implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LeaveJobs.name);
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(LEAVE_REPOSITORY) private readonly repo: LeaveRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly shiftPeople: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly accounts: LeaveAccountsService,
    private readonly people: LeavePeopleService,
  ) {}

  onApplicationBootstrap(): void {
    this.events.subscribe('calendar.changed', () => this.soon());
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  @Cron('20 0 * * *', { name: 'leave-open-year', timeZone: appTimezone() })
  async openYear(now: Date = new Date()): Promise<void> {
    try {
      const everyone = await this.shiftPeople.listAllActive();
      const opened = await this.accounts.openYear(everyone, now);
      if (opened)
        this.logger.log(`leave: opened ${opened} accounts for ${dateKeyInZone(now).slice(0, 4)}`);
    } catch (err) {
      this.logger.warn(`leave-open-year failed: ${(err as Error).message}`);
    }
  }

  private soon(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reprice();
    }, REPRICE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Gives back days of active leave that are no longer working days. */
  async reprice(now: Date = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let changed = 0;
    try {
      const from = addDaysToKey(dateKeyInZone(now, appTimezone()), -REPRICE_BACK_DAYS);
      const active = await this.repo.activeRequestsFrom(from);
      const people = await this.people.any(active.map((r) => r.userId));
      for (const r of active) {
        const person = people.get(r.userId);
        if (!person) continue;
        try {
          if (await this.repriceOne(r, person, from, now)) changed += 1;
        } catch (err) {
          this.logger.warn(`leave ${r.id} not repriced: ${(err as Error).message}`);
        }
      }
      if (changed) this.logger.log(`leave: ${changed} requests repriced after a calendar change`);
    } catch (err) {
      this.logger.warn(`leave reprice failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
    return changed;
  }

  private async repriceOne(
    r: LeaveRequestRecord,
    person: Parameters<LeavePeopleService['dayInfos']>[0],
    from: string,
    now: Date,
  ): Promise<boolean> {
    const dates = r.days.filter((d) => d.date >= from).map((d) => d.date);
    if (!dates.length) return false;
    const infos = await this.people.dayInfos(person, dates);
    const off = infos.filter((i) => !i.workday);
    if (!off.length) return false;
    const result = await this.repo.inUserLock(r.userId, async (tx) => {
      const cur = await tx.findRequest(r.id);
      if (!cur || (cur.status !== 'PENDING' && cur.status !== 'APPROVED')) return null;
      const offDates = new Set(off.map((o) => o.date));
      const goneMonths = new Set(
        cur.days.filter((d) => offDates.has(d.date)).map((d) => d.date.slice(0, 7)),
      );
      // A locked month is never changed: those days stay as they were paid.
      for (const month of goneMonths) {
        if (!(await tx.isMonthLocked(`${month}-01`, cur.userId))) continue;
        for (const d of [...offDates]) if (d.startsWith(`${month}-`)) offDates.delete(d);
      }
      const kept = cur.days.filter((d) => !offDates.has(d.date));
      if (kept.length === cur.days.length) return null;
      const units = kept.reduce((n, d) => n + d.units, 0);
      const updated = kept.length
        ? await tx.updateRequest(cur.id, { units }, kept)
        : await tx.updateRequest(cur.id, {
            status: 'CANCELLED',
            cancelledAt: now,
            decisionNote: 'Every day of this leave became a day off, so nothing is charged.',
          });
      return { updated, givenBack: off.filter((o) => offDates.has(o.date)) };
    });
    if (!result) return false;
    const copy = leaveUpdatedCopy({
      request: {
        category: result.updated.category,
        startDate: result.updated.startDate,
        endDate: result.updated.endDate,
        units: result.updated.units,
        kindLabel: kindLabel(result.updated.kind, result.updated.part),
        reason: result.updated.reason,
      },
      givenBack: result.givenBack.map((g) => ({ date: g.date, why: g.offLabel ?? 'Day off' })),
      cancelled: result.updated.status === 'CANCELLED',
    });
    await this.events.publish(
      NoticeEvent.eventName,
      new NoticeEvent([r.userId], LEAVE_NOTICE.LEAVE_UPDATED, copy.title, copy.body, null, {
        what: 'LEAVE',
        id: r.id,
        action: result.updated.status === 'CANCELLED' ? 'CANCELLED' : 'UPDATED',
      }),
    );
    await this.events.publish(
      LeaveChangedEvent.eventName,
      new LeaveChangedEvent(r.userId, r.startDate, r.endDate),
    );
    return true;
  }
}
