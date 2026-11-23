import { Inject, Injectable, Logger } from '@nestjs/common';
import { addDaysToKey, appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import {
  BIOMETRIC_REPOSITORY,
  BiometricRepository,
  NewPunch,
  PunchRecord,
} from '../domain/biometric.repository';
import {
  CleanPunch,
  cleanPunch,
  dayKeyForPunch,
  planBiometricDay,
  PunchInput,
  PunchSource,
} from '../domain/punch';
import { BiometricDaysService, validPunches } from './biometric-days.service';
import { BiometricSettingsService } from './biometric-settings.service';

/** At most this many punches in one call (a JSON body is at most 100 KB). */
export const MAX_PUNCHES_PER_CALL = 500;

export interface IngestResult {
  received: number;
  stored: number;
  duplicates: number;
  /** Stored with a code nobody has yet (listed under Unmatched codes). */
  unmatched: number;
  /** Stored for a day in a month locked for payroll: kept, not applied. */
  lockedOut: number;
  /** People whose day was worked out again. */
  daysUpdated: number;
  ignored: { index: number; reason: string }[];
}

interface Owned {
  punch: CleanPunch;
  person: ShiftPerson | null;
  dayKey: string;
}

/**
 * Punches in (3.5): from the push API, the pull adapter, a CSV file or by hand.
 * Each is checked, matched to the person holding its code, given the working day
 * it belongs to, stored once (the same code, time and device twice is one punch),
 * and the days it touches are worked out again. 4.0: punches come in for one
 * organisation and match its people only (a code is unique within an organisation).
 */
@Injectable()
export class BiometricIngestService {
  private readonly logger = new Logger(BiometricIngestService.name);

  constructor(
    @Inject(BIOMETRIC_REPOSITORY) private readonly repo: BiometricRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
    private readonly settings: BiometricSettingsService,
    private readonly biometricDays: BiometricDaysService,
  ) {}

  async ingest(
    companyId: string,
    inputs: PunchInput[],
    source: PunchSource,
    ctx: {
      now: Date;
      keyId?: string | null;
      actorId?: string | null;
      note?: string | null;
      inWords?: readonly string[];
      outWords?: readonly string[];
    },
  ): Promise<IngestResult> {
    const tz = appTimezone();
    const s = await this.settings.get(companyId);
    const words =
      source === 'PULL'
        ? { inWords: ctx.inWords ?? s.pull.inWords, outWords: ctx.outWords ?? s.pull.outWords }
        : { inWords: ctx.inWords ?? s.pushInWords, outWords: ctx.outWords ?? s.pushOutWords };
    const ignored: IngestResult['ignored'] = [];
    const clean: CleanPunch[] = [];
    inputs.slice(0, MAX_PUNCHES_PER_CALL).forEach((input, index) => {
      const c = cleanPunch(input ?? ({} as PunchInput), { now: ctx.now, tz, ...words });
      if (c.ok) clean.push(c.value);
      else ignored.push({ index, reason: c.why });
    });
    if (inputs.length > MAX_PUNCHES_PER_CALL) {
      for (let i = MAX_PUNCHES_PER_CALL; i < inputs.length; i++) {
        ignored.push({ index: i, reason: `at most ${MAX_PUNCHES_PER_CALL} punches per call` });
      }
    }
    const owned = await this.assignDays(companyId, clean, ctx.now);
    const locked = await this.repo.lockedMonths(
      companyId,
      owned.map((o) => o.dayKey.slice(0, 7)),
    );
    const rows: NewPunch[] = owned.map((o) => ({
      companyId,
      code: o.punch.code,
      codeKey: o.punch.codeKey,
      punchedAt: o.punch.punchedAt,
      direction: o.punch.direction,
      deviceId: o.punch.deviceId,
      externalId: o.punch.externalId,
      source,
      userId: o.person?.id ?? null,
      dayKey: o.dayKey,
      note: ctx.note ?? null,
      createdById: ctx.actorId ?? null,
      keyId: ctx.keyId ?? null,
      lockedOut: !!o.person && locked.has(o.dayKey.slice(0, 7)),
    }));
    const { inserted, duplicates } = await this.repo.insertPunches(rows);
    const daysUpdated = await this.rebuildFor(inserted, ctx.now);
    const result: IngestResult = {
      received: inputs.length,
      stored: inserted.length,
      duplicates,
      unmatched: inserted.filter((p) => !p.userId).length,
      lockedOut: inserted.filter((p) => p.lockedOut).length,
      daysUpdated,
      ignored,
    };
    if (inserted.length || ignored.length) {
      this.logger.log(
        `biometric ${source} for ${companyId}: ${result.stored} stored, ${duplicates} duplicate, ${result.unmatched} unmatched, ` +
          `${ignored.length} ignored, ${daysUpdated} day(s) updated`,
      );
    }
    return result;
  }

  /** Works out again the days these punches touched. */
  async rebuildFor(punches: PunchRecord[], now: Date): Promise<number> {
    const byUser = new Map<string, Set<string>>();
    for (const p of punches) {
      if (!p.userId || p.lockedOut) continue;
      const set = byUser.get(p.userId) ?? new Set<string>();
      set.add(p.dayKey);
      byUser.set(p.userId, set);
    }
    let n = 0;
    for (const [userId, dayKeys] of byUser)
      n += await this.biometricDays.rebuild(userId, [...dayKeys], now);
    return n;
  }

  /**
   * The person and the working day of each punch. A person's punches go in time
   * order: each is dated by the shift-day it falls in, unless it closes a day that is
   * still open from the evening before (within 16 hours of that day's first punch).
   */
  async assignDays(companyId: string, clean: CleanPunch[], now: Date): Promise<Owned[]> {
    const tz = appTimezone();
    const byCode = await this.repo.peopleByCodes(
      companyId,
      clean.map((c) => c.codeKey),
    );
    const ids = [...new Set([...byCode.values()].map((p) => p.id))];
    const people = new Map((await this.people.findAnyByIds(ids)).map((p) => [p.id, p]));
    const ctx = ids.length ? await this.days.context(ids) : null;
    const out: Owned[] = [];
    const mine = new Map<string, CleanPunch[]>();
    for (const c of clean) {
      const person = people.get(byCode.get(c.codeKey)?.id ?? '') ?? null;
      if (!person || !ctx) {
        out.push({ punch: c, person: null, dayKey: dateKeyInZone(c.punchedAt, tz) });
        continue;
      }
      mine.set(person.id, [...(mine.get(person.id) ?? []), c]);
    }
    for (const [userId, list] of mine) {
      const person = people.get(userId)!;
      list.sort((a, b) => a.punchedAt.getTime() - b.punchedAt.getTime());
      const shiftDays = list.map((c) => this.days.dayWith(ctx!, person, c.punchedAt).dateKey);
      const around = [...new Set(shiftDays.flatMap((d) => [d, addDaysToKey(d, -1)]))];
      // What is stored already for those days, then this batch as it is dated.
      const byDay = new Map<string, { at: Date; direction: CleanPunch['direction'] }[]>();
      for (const p of await this.repo.punchesOfDays(userId, around)) {
        byDay.set(p.dayKey, [...(byDay.get(p.dayKey) ?? []), ...validPunches([p])]);
      }
      const openNow = (dayKey: string) => {
        const list = byDay.get(dayKey) ?? [];
        if (!list.length) return { open: false, firstAt: null as Date | null };
        // Open by its punches alone (no cutoff yet): the last one a check-in.
        const plan = planBiometricDay(list, {
          gapRule: 'SPAN',
          missingCheckout: 'LAST_PUNCH',
          duplicateWindowSec: 60,
          cutoff: new Date(8.64e15),
          shiftEnd: null,
          now,
        });
        return { open: plan.open, firstAt: plan.used[0]?.at ?? null };
      };
      list.forEach((c, i) => {
        const shiftDay = shiftDays[i];
        const dayKey = dayKeyForPunch({
          at: c.punchedAt,
          shiftDay,
          shiftDayHasPunches: (byDay.get(shiftDay) ?? []).some(
            (p) => p.at.getTime() !== c.punchedAt.getTime(),
          ),
          previous: openNow(addDaysToKey(shiftDay, -1)),
        });
        byDay.set(dayKey, [
          ...(byDay.get(dayKey) ?? []),
          { at: c.punchedAt, direction: c.direction },
        ]);
        out.push({ punch: c, person, dayKey });
      });
    }
    return out;
  }

  /**
   * After a code is given to someone, taken away or changed: every punch with those
   * codes is matched again (punches in locked months stay as they were), and the
   * days of the people concerned are worked out again.
   */
  async rematch(
    companyId: string,
    codeKeys: string[],
    now: Date,
  ): Promise<{ punches: number; daysUpdated: number }> {
    const punches = await this.repo.punchesWithCodes(companyId, codeKeys);
    if (!punches.length) return { punches: 0, daysUpdated: 0 };
    const lockedNow = await this.repo.lockedMonths(
      companyId,
      punches.map((p) => p.dayKey.slice(0, 7)),
    );
    const movable = punches.filter((p) => !(p.userId && lockedNow.has(p.dayKey.slice(0, 7))));
    const assigned = await this.assignDays(
      companyId,
      movable.map((p) => ({
        code: p.code,
        codeKey: p.codeKey,
        punchedAt: p.punchedAt,
        direction: p.direction,
        deviceId: p.deviceId,
        externalId: p.externalId,
      })),
      now,
    );
    const lockedAfter = await this.repo.lockedMonths(
      companyId,
      assigned.map((a) => a.dayKey.slice(0, 7)),
    );
    const updates: { id: string; userId: string | null; dayKey: string; lockedOut: boolean }[] = [];
    const touched = new Map<string, Set<string>>();
    const mark = (userId: string | null, dayKey: string) => {
      if (!userId) return;
      const set = touched.get(userId) ?? new Set<string>();
      set.add(dayKey);
      touched.set(userId, set);
    };
    const keyOf = (codeKey: string, at: Date, deviceId: string) =>
      `${codeKey}|${at.getTime()}|${deviceId}`;
    const byKey = new Map(
      assigned.map((a) => [keyOf(a.punch.codeKey, a.punch.punchedAt, a.punch.deviceId), a]),
    );
    movable.forEach((p) => {
      const a = byKey.get(keyOf(p.codeKey, p.punchedAt, p.deviceId));
      if (!a) return;
      const userId = a.person?.id ?? null;
      const lockedOut = !!userId && lockedAfter.has(a.dayKey.slice(0, 7));
      if (userId === p.userId && a.dayKey === p.dayKey && lockedOut === p.lockedOut) return;
      updates.push({ id: p.id, userId, dayKey: a.dayKey, lockedOut });
      mark(p.userId, p.dayKey);
      mark(userId, a.dayKey);
    });
    await this.repo.setPunchOwner(updates);
    let daysUpdated = 0;
    for (const [userId, days] of touched)
      daysUpdated += await this.biometricDays.rebuild(userId, [...days], now);
    return { punches: updates.length, daysUpdated };
  }
}
