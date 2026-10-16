import { Inject, Injectable } from '@nestjs/common';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { breakSlots, isWorkDay, shiftDayKey } from '../domain/break-schedule';
import { PersonForShift, ResolvedShift, resolveShift } from '../domain/shift-resolution';
import { SHIFT_REPOSITORY, ShiftRepository } from '../domain/shift.repository';
import { BreakSlot, ShiftAssignmentRecord, ShiftRecord } from '../domain/shift.types';

export interface BreakDay {
  /** The shift-day the moment belongs to (YYYY-MM-DD). */
  dateKey: string;
  resolved: ResolvedShift;
  workday: boolean;
  /** Enabled breaks of the resolved shift on that day (empty on a day off). */
  slots: BreakSlot[];
}

/** Everything needed to resolve many people at once without N+1 queries. */
export interface ResolutionContext {
  shiftsById: Map<string, ShiftRecord>;
  defaults: ShiftRecord[];
  assignments: ShiftAssignmentRecord[];
}

/**
 * Shifts and assignments are read once a minute at most: they change rarely, and
 * the presence poll of 2.9.1 agents (every 5 s each) resolves a shift-day on every
 * call. Writes through the shift and assignment use cases clear it at once.
 */
export const CONTEXT_TTL_MS = 60_000;

interface CachedContext {
  at: number;
  shifts: Promise<ShiftRecord[]>;
  assignments: Promise<ShiftAssignmentRecord[]>;
}

/**
 * Works out, for a person and a moment, which shift applies and what their
 * breaks look like. One place, so the agent, the portal and the approval flow
 * can never disagree about someone's schedule.
 */
@Injectable()
export class BreakDayService {
  private cached: CachedContext | null = null;

  constructor(@Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepository) {}

  get timezone(): string {
    return appTimezone();
  }

  async context(userIds: string[]): Promise<ResolutionContext> {
    const source = this.source();
    const [all, rows] = await Promise.all([source.shifts, source.assignments]);
    const ids = new Set(userIds);
    return {
      shiftsById: new Map(all.map((s) => [s.id, s])),
      defaults: all.filter((s) => s.isDefault),
      // Department rows apply to anyone; personal rows only to these people.
      assignments: rows.filter(
        (a) => a.target === 'DEPARTMENT' || (a.userId !== null && ids.has(a.userId)),
      ),
    };
  }

  /** Forget the cached shifts and assignments (a shift or an assignment changed). */
  invalidate(): void {
    this.cached = null;
  }

  private source(now = Date.now()): CachedContext {
    if (this.cached && now - this.cached.at < CONTEXT_TTL_MS) return this.cached;
    const entry: CachedContext = {
      at: now,
      shifts: this.shifts.list(),
      assignments: this.shifts.listAllAssignments(),
    };
    // A failed read is never kept.
    const drop = () => {
      if (this.cached === entry) this.cached = null;
    };
    entry.shifts.catch(drop);
    entry.assignments.catch(drop);
    this.cached = entry;
    return entry;
  }

  resolveWith(ctx: ResolutionContext, person: PersonForShift, dateKey: string): ResolvedShift {
    return resolveShift(person, dateKey, ctx.assignments, ctx.shiftsById, ctx.defaults);
  }

  /** The person's break day for `now` (handles shifts that run past midnight). */
  dayWith(ctx: ResolutionContext, person: PersonForShift, now: Date): BreakDay {
    const tz = this.timezone;
    const today = dateKeyInZone(now, tz);
    let dateKey = today;
    let resolved = this.resolveWith(ctx, person, today);

    if (resolved.shift) {
      const candidate = shiftDayKey(resolved.shift, now, tz);
      if (candidate !== today) {
        // Early hours of an overnight shift: it belongs to yesterday's shift, if
        // yesterday's assignment is also an overnight shift still running now.
        const yesterday = this.resolveWith(ctx, person, candidate);
        if (yesterday.shift && shiftDayKey(yesterday.shift, now, tz) === candidate) {
          dateKey = candidate;
          resolved = yesterday;
        }
      }
    }
    return this.forDate(resolved, dateKey);
  }

  /** The break day for an explicit shift-day (portal views of a past or future day). */
  forDate(resolved: ResolvedShift, dateKey: string): BreakDay {
    const shift = resolved.shift;
    const workday = shift ? isWorkDay(shift, dateKey) : false;
    const slots = shift && workday ? breakSlots(shift, dateKey, this.timezone) : [];
    return { dateKey, resolved, workday, slots };
  }

  async dayFor(person: PersonForShift, now: Date): Promise<BreakDay> {
    const ctx = await this.context([person.id]);
    return this.dayWith(ctx, person, now);
  }
}
