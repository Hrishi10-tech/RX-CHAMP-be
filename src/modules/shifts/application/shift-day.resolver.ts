import { Inject, Injectable } from '@nestjs/common';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader, ShiftPerson } from '../domain/shift-people.reader';
import { BreakDayService, CONTEXT_TTL_MS, ResolutionContext } from './break-day.service';

/** People kept for resolution (company, department), at most this many. */
const PERSON_CACHE_MAX = 10_000;

/** The working-day key of one person at a moment. */
export type DayKeyFn = (at: Date) => string;

/**
 * Which working day a moment belongs to, per person: their shift-day (the early
 * hours of an overnight shift belong to the evening it started), else the
 * calendar day in the business timezone. Session dates, "today" in the working
 * day, Team today and presence all use it, so a night shift is one day everywhere.
 */
@Injectable()
export class ShiftDayResolver {
  /** Person rows by id, kept as long as the shift context (null: no such person). */
  private readonly personCache = new Map<string, { at: number; person: ShiftPerson | null }>();

  constructor(
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
  ) {}

  /** A reusable key function for one person (one lookup, then pure). */
  async keyFnFor(userId: string): Promise<DayKeyFn> {
    const person = (await this.persons([userId])).get(userId);
    if (!person) return (at) => dateKeyInZone(at, appTimezone());
    const ctx = await this.days.context([userId]);
    return this.keyFnWith(ctx, person);
  }

  /** Pure key function from an already loaded context. */
  keyFnWith(
    ctx: ResolutionContext,
    person: Pick<ShiftPerson, 'id' | 'companyId' | 'department'>,
  ): DayKeyFn {
    return (at) => this.days.dayWith(ctx, person, at).dateKey;
  }

  /** The working day at `at` for one person. */
  async dayKeyAt(userId: string, at: Date): Promise<string> {
    return (await this.keyFnFor(userId))(at);
  }

  /** The working day at `at` for many people (one query per table). */
  async dayKeysAt(userIds: string[], at: Date): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = [...new Set(userIds)];
    if (!ids.length) return out;
    const [people, ctx] = await Promise.all([this.persons(ids), this.days.context(ids)]);
    const calendar = dateKeyInZone(at, appTimezone());
    for (const id of ids) out.set(id, calendar);
    for (const p of people.values()) out.set(p.id, this.days.dayWith(ctx, p, at).dateKey);
    return out;
  }

  /** The people (any status), read at most once a minute each. */
  private async persons(ids: string[], now = Date.now()): Promise<Map<string, ShiftPerson>> {
    const out = new Map<string, ShiftPerson>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = this.personCache.get(id);
      if (hit && now - hit.at < CONTEXT_TTL_MS) {
        if (hit.person) out.set(id, hit.person);
      } else {
        missing.push(id);
      }
    }
    if (!missing.length) return out;
    const found = new Map((await this.people.findAnyByIds(missing)).map((p) => [p.id, p]));
    if (this.personCache.size + missing.length > PERSON_CACHE_MAX) this.personCache.clear();
    for (const id of missing) {
      const person = found.get(id) ?? null;
      this.personCache.set(id, { at: now, person });
      if (person) out.set(id, person);
    }
    return out;
  }
}
