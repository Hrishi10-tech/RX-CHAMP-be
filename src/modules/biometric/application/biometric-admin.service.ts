import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { isAdminLike, requireOrg } from '@shared/tenancy';
import {
  addDaysToKey,
  appTimezone,
  dateKeyInZone,
  isValidDateKey,
  startOfDayInZone,
} from '@shared/utils/timezone';
import {
  AttendanceWrite,
  BIOMETRIC_REPOSITORY,
  BiometricPerson,
  BiometricRepository,
  PunchRecord,
} from '../domain/biometric.repository';
import { normalizeCode, normalizeDirection, parsePunchTime } from '../domain/punch';
import { BiometricDaysService } from './biometric-days.service';
import { BiometricIngestService, IngestResult } from './biometric-ingest.service';
import { BiometricKeysService } from './biometric-keys.service';
import { BiometricSettingsService } from './biometric-settings.service';

const NOTE_MIN = 3;
const NOTE_MAX = 300;
/** Rows per import call (the portal sends a longer file in parts). */
const CSV_MAX_ROWS = 2_000;

export interface PersonAttendanceView {
  userId: string;
  name: string;
  email: string;
  role: string;
  department: string | null;
  companyId: string | null;
  companyName: string | null;
  attendanceSource: 'AGENT' | 'BIOMETRIC';
  biometricCode: string | null;
  attendanceSourceFrom: string | null;
  lastPunchAt: string | null;
}

export interface PunchView {
  id: string;
  code: string;
  punchedAt: string;
  direction: 'IN' | 'OUT' | null;
  deviceId: string;
  source: string;
  userId: string | null;
  userName: string | null;
  dayKey: string;
  note: string | null;
  addedBy: string | null;
  lockedOut: boolean;
  voided: boolean;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
  receivedAt: string;
}

/**
 * The stretch on biometric that a move back to the agent ends (3.6): up to yesterday, as a
 * change of source applies from today. Null when none ends, or when it only began today.
 */
export function biometricStretchEnded(
  before: Pick<BiometricPerson, 'attendanceSource' | 'attendanceSourceFrom'>,
  source: 'AGENT' | 'BIOMETRIC',
  today: string,
): { fromDate: string | null; toDate: string } | null {
  if (before.attendanceSource !== 'BIOMETRIC' || source !== 'AGENT') return null;
  const toDate = addDaysToKey(today, -1);
  const fromDate = before.attendanceSourceFrom;
  return fromDate && fromDate > toDate ? null : { fromDate, toDate };
}

function name(p: { firstName: string; lastName: string } | undefined | null): string {
  if (!p) return 'Former user';
  return `${p.firstName} ${p.lastName}`.trim() || 'Former user';
}

function note(value: unknown, field: string, what: string): string {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text.length < NOTE_MIN || text.length > NOTE_MAX) {
    throw new ValidationError(`Give ${what}, ${NOTE_MIN} to ${NOTE_MAX} characters.`).withDetails({
      field,
    });
  }
  return text;
}

/** One CSV line into cells (double quotes, doubled quotes inside). */
export function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';' || ch === '\t') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const HEADER_ALIASES: Record<string, string[]> = {
  code: [
    'code',
    'biometric id',
    'biometricid',
    'employee code',
    'emp_code',
    'empcode',
    'employee id',
    'user id',
    'userid',
    'id',
  ],
  time: [
    'time',
    'punch time',
    'punch_time',
    'datetime',
    'date time',
    'timestamp',
    'logtime',
    'log time',
  ],
  direction: ['direction', 'type', 'in/out', 'inout', 'punch_state', 'state', 'status'],
  deviceId: ['deviceid', 'device', 'device id', 'terminal', 'terminal_sn', 'terminal sn'],
  externalId: ['externalid', 'external id', 'punch id', 'log id', 'transaction id'],
};

/**
 * The Attendance page (3.5): who checks in how, the punch log, punches added or
 * voided by hand, codes nobody has, devices seen, a CSV import, and the
 * integration's status. 4.0: all of it is the organisation's in view; its admins
 * (and a Super Admin acting in it) change; the Super Manager reads and adds or
 * voids punches.
 */
@Injectable()
export class BiometricAdminService {
  private readonly logger = new Logger(BiometricAdminService.name);

  constructor(
    @Inject(BIOMETRIC_REPOSITORY) private readonly repo: BiometricRepository,
    private readonly ingest: BiometricIngestService,
    private readonly days: BiometricDaysService,
    private readonly keys: BiometricKeysService,
    private readonly settings: BiometricSettingsService,
  ) {}

  /** The organisation admin (or a Super Admin in it): the organisation changed. */
  private changer(me: AuthenticatedUser): string {
    if (!isAdminLike(me)) throw new ForbiddenError('Only the organisation admin can change this.');
    return requireOrg(me);
  }

  /** The organisation admin or the Super Manager: the organisation read. */
  private reader(me: AuthenticatedUser): string {
    if (!isAdminLike(me) && me.role !== Role.SUPER_MANAGER) {
      throw new ForbiddenError(
        'Only the organisation admin or the Super Manager can see attendance settings.',
      );
    }
    return requireOrg(me);
  }

  // ---- People -----------------------------------------------------------------------

  async people(
    me: AuthenticatedUser,
    q: { search?: string; companyId?: string; source?: 'AGENT' | 'BIOMETRIC' },
  ): Promise<PersonAttendanceView[]> {
    const companyId = this.reader(me);
    const rows = await this.repo.people({ search: q.search, source: q.source, companyId });
    const last = await this.repo.lastPunchOf(rows.map((r) => r.id));
    return rows.map((p) => this.personView(p, last.get(p.id) ?? null));
  }

  private personView(p: BiometricPerson, last: Date | null): PersonAttendanceView {
    return {
      userId: p.id,
      name: name(p),
      email: p.email,
      role: p.role,
      department: p.department,
      companyId: p.companyId,
      companyName: p.companyName,
      attendanceSource: p.attendanceSource,
      biometricCode: p.biometricCode,
      attendanceSourceFrom: p.attendanceSourceFrom,
      lastPunchAt: last?.toISOString() ?? null,
    };
  }

  /**
   * Who checks in how, for one person or many: the source and the biometric ID.
   * Someone on biometric needs an ID; an ID belongs to one person. A change of source
   * applies from today.
   */
  async setPeople(
    me: AuthenticatedUser,
    items: { userId: string; attendanceSource?: unknown; biometricCode?: unknown }[],
    now: Date,
  ): Promise<{ updated: PersonAttendanceView[]; rematched: number }> {
    const companyId = this.changer(me);
    if (!Array.isArray(items) || !items.length || items.length > 500) {
      throw new ValidationError('Send 1 to 500 people.').withDetails({ field: 'items' });
    }
    const ids = [...new Set(items.map((i) => i.userId))];
    if (ids.length !== items.length) {
      throw new ValidationError('A person is listed twice.').withDetails({ field: 'items' });
    }
    // 4.0: people of another organisation are unknown here.
    const current = new Map((await this.repo.people({ ids, companyId })).map((p) => [p.id, p]));
    const unknown = ids.filter((id) => !current.has(id));
    if (unknown.length) {
      throw new ValidationError('Some of these people are unknown or not active.').withDetails({
        field: 'items',
        unknown,
      });
    }
    const today = dateKeyInZone(now, appTimezone());
    const writes: AttendanceWrite[] = [];
    const codes = new Map<string, string>();
    for (const [i, item] of items.entries()) {
      const p = current.get(item.userId)!;
      const source =
        item.attendanceSource === undefined
          ? p.attendanceSource
          : item.attendanceSource === 'AGENT' || item.attendanceSource === 'BIOMETRIC'
            ? item.attendanceSource
            : null;
      if (!source) {
        throw new ValidationError('Attendance is AGENT or BIOMETRIC.').withDetails({
          field: `items.${i}.attendanceSource`,
        });
      }
      let code: string | null = p.biometricCode;
      if (item.biometricCode !== undefined) {
        if (item.biometricCode === null || item.biometricCode === '') code = null;
        else {
          code = normalizeCode(item.biometricCode);
          if (!code) {
            throw new ValidationError(
              `${name(p)}: a biometric ID is 1 to 64 letters or digits.`,
            ).withDetails({
              field: `items.${i}.biometricCode`,
            });
          }
        }
      }
      if (source === 'BIOMETRIC' && !code) {
        throw new ValidationError(
          `${name(p)} checks in by biometric: give their biometric ID.`,
        ).withDetails({
          field: `items.${i}.biometricCode`,
        });
      }
      if (code) {
        const twice = codes.get(code);
        if (twice) {
          throw new ConflictError(
            `${code} is given to two people here.`,
            'BIOMETRIC_CODE_TAKEN',
          ).withDetails({
            code,
          });
        }
        codes.set(code, p.id);
      }
      const endedBiometric = biometricStretchEnded(p, source, today);
      writes.push({
        userId: p.id,
        attendanceSource: source,
        biometricCode: code,
        attendanceSourceFrom: source !== p.attendanceSource ? today : p.attendanceSourceFrom,
        ...(endedBiometric ? { endedBiometric } : {}),
      });
    }
    // A code held by someone not in this change.
    if (codes.size) {
      const holders = await this.repo.peopleByCodes(companyId, [...codes.keys()]);
      for (const [code, holder] of holders) {
        if (!ids.includes(holder.id) && codes.get(code) !== holder.id) {
          throw new ConflictError(
            `Biometric ID ${code} belongs to ${name(holder)}. Take it from them first.`,
            'BIOMETRIC_CODE_TAKEN',
          ).withDetails({ code, userId: holder.id });
        }
      }
    }
    await this.repo.setAttendance(writes, now, me.id);
    // Someone off biometric now: a biometric day still open closes at its last punch.
    for (const w of writes) {
      const before = current.get(w.userId)!;
      if (before.attendanceSource === 'BIOMETRIC' && w.attendanceSource !== 'BIOMETRIC') {
        await this.days.closeOpen(w.userId, now);
      }
    }
    const affected = new Set<string>();
    for (const w of writes) {
      const before = current.get(w.userId)!;
      if (
        before.biometricCode !== w.biometricCode ||
        before.attendanceSource !== w.attendanceSource
      ) {
        if (before.biometricCode) affected.add(before.biometricCode);
        if (w.biometricCode) affected.add(w.biometricCode);
      }
    }
    const rematched = affected.size
      ? await this.ingest.rematch(companyId, [...affected], now)
      : { punches: 0, daysUpdated: 0 };
    this.logger.log(
      `attendance of ${writes.length} people set by ${me.id}; ${rematched.punches} punches matched again`,
    );
    const after = await this.repo.people({ ids, companyId });
    const last = await this.repo.lastPunchOf(ids);
    return {
      updated: after.map((p) => this.personView(p, last.get(p.id) ?? null)),
      rematched: rematched.punches,
    };
  }

  // ---- Punches ----------------------------------------------------------------------

  async punches(
    me: AuthenticatedUser,
    q: {
      from?: string;
      to?: string;
      userId?: string;
      code?: string;
      deviceId?: string;
      unmatched?: boolean;
      includeVoided?: boolean;
      limit?: number;
    },
  ): Promise<{ items: PunchView[]; total: number }> {
    const companyId = this.reader(me);
    const tz = appTimezone();
    const from = q.from && isValidDateKey(q.from) ? startOfDayInZone(q.from, tz) : undefined;
    const to =
      q.to && isValidDateKey(q.to) ? startOfDayInZone(addDaysToKey(q.to, 1), tz) : undefined;
    const { items, total } = await this.repo.listPunches({
      companyId,
      from,
      to: to ? new Date(to.getTime() - 1) : undefined,
      userId: q.userId,
      codeKey: q.code ? (normalizeCode(q.code) ?? undefined) : undefined,
      deviceId: q.deviceId,
      unmatchedOnly: q.unmatched,
      includeVoided: q.includeVoided,
      limit: q.limit,
    });
    return { items: await this.punchViews(companyId, items), total };
  }

  async punchViews(companyId: string, rows: PunchRecord[]): Promise<PunchView[]> {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.userId, r.createdById, r.voidedById])
          .filter((x): x is string => !!x),
      ),
    ];
    // People no longer active still need names in the log.
    const people = await this.repo.names(ids);
    const keys = new Map((await this.keys.list(companyId)).map((k) => [k.id, k.name]));
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      punchedAt: r.punchedAt.toISOString(),
      direction: r.direction,
      deviceId: r.deviceId,
      source: r.source,
      userId: r.userId,
      userName: r.userId
        ? people.has(r.userId)
          ? name(people.get(r.userId))
          : 'Former user'
        : null,
      dayKey: r.dayKey,
      note: r.note,
      addedBy: r.createdById
        ? people.has(r.createdById)
          ? name(people.get(r.createdById))
          : 'Former user'
        : r.keyId
          ? `Key: ${keys.get(r.keyId) ?? 'revoked'}`
          : null,
      lockedOut: r.lockedOut,
      voided: !!r.voidedAt,
      voidedAt: r.voidedAt?.toISOString() ?? null,
      voidedBy: r.voidedById
        ? people.has(r.voidedById)
          ? name(people.get(r.voidedById))
          : 'Former user'
        : null,
      voidReason: r.voidReason,
      receivedAt: r.receivedAt.toISOString(),
    }));
  }

  /** A missing punch, added by hand with a reason (the organisation admin, the Super Manager). */
  async addPunch(
    me: AuthenticatedUser,
    dto: { userId: string; time: unknown; direction?: unknown; note: unknown },
    now: Date,
  ): Promise<PunchView> {
    const companyId = this.reader(me);
    const person = (await this.repo.people({ ids: [dto.userId], companyId }))[0];
    if (!person) throw new NotFoundError('Unknown person');
    if (!person.biometricCode) {
      throw new ConflictError(
        `${name(person)} has no biometric ID yet: give them one first.`,
        'NO_BIOMETRIC_CODE',
      );
    }
    const text = note(dto.note, 'note', 'the reason for adding the punch');
    const at = parsePunchTime(dto.time, appTimezone());
    if (!at)
      throw new ValidationError(
        'Give the punch time (YYYY-MM-DD HH:MM, business time).',
      ).withDetails({ field: 'time' });
    if (at.getTime() > now.getTime()) {
      throw new ValidationError('A punch added by hand cannot be in the future.').withDetails({
        field: 'time',
      });
    }
    const direction =
      dto.direction === undefined || dto.direction === null || dto.direction === ''
        ? null
        : normalizeDirection(dto.direction);
    if (dto.direction && !direction) {
      throw new ValidationError('Direction is IN, OUT or empty.').withDetails({
        field: 'direction',
      });
    }
    const [owned] = await this.ingest.assignDays(
      companyId,
      [
        {
          code: person.biometricCode,
          codeKey: person.biometricCode,
          punchedAt: at,
          direction,
          deviceId: 'MANUAL',
          externalId: null,
        },
      ],
      now,
    );
    if ((await this.repo.lockedMonths(companyId, [owned.dayKey.slice(0, 7)])).size) {
      throw new ConflictError(
        `${owned.dayKey.slice(0, 7)} is locked for payroll. Unlock the month first.`,
        'MONTH_LOCKED',
      ).withDetails({ month: owned.dayKey.slice(0, 7) });
    }
    const result = await this.ingest.ingest(
      companyId,
      [
        {
          code: person.biometricCode,
          time: at.toISOString(),
          direction: direction ?? undefined,
          deviceId: 'MANUAL',
        },
      ],
      'MANUAL',
      { now, actorId: me.id, note: text },
    );
    if (!result.stored) {
      throw new ConflictError(
        'There is already a punch for them at that very time.',
        'DUPLICATE_PUNCH',
      );
    }
    const { items } = await this.repo.listPunches({
      companyId,
      userId: person.id,
      from: at,
      to: at,
      deviceId: 'MANUAL',
      includeVoided: true,
      limit: 1,
    });
    this.logger.log(`punch added by hand for ${person.id} at ${at.toISOString()} by ${me.id}`);
    return (await this.punchViews(companyId, items))[0];
  }

  /** A wrong punch voided with a reason: it stays in the log, struck through. */
  async voidPunch(
    me: AuthenticatedUser,
    id: string,
    reason: unknown,
    now: Date,
  ): Promise<PunchView> {
    const companyId = this.reader(me);
    const p = await this.repo.findPunch(id);
    // 4.0: another organisation's punch does not exist here.
    if (!p || p.companyId !== companyId) throw new NotFoundError('Unknown punch');
    if (p.voidedAt) throw new ConflictError('This punch is already voided.', 'ALREADY_VOIDED');
    const text = note(reason, 'reason', 'the reason for voiding it');
    if (p.userId && (await this.repo.lockedMonths(companyId, [p.dayKey.slice(0, 7)])).size) {
      throw new ConflictError(
        `${p.dayKey.slice(0, 7)} is locked for payroll. Unlock the month first.`,
        'MONTH_LOCKED',
      ).withDetails({ month: p.dayKey.slice(0, 7) });
    }
    const saved = await this.repo.voidPunch(id, me.id, text, now);
    if (saved.userId) await this.days.rebuild(saved.userId, [saved.dayKey], now);
    this.logger.log(`punch ${id} voided by ${me.id}`);
    return (await this.punchViews(companyId, [saved]))[0];
  }

  /** CSV: a header row, then code, time and optionally direction, deviceId, externalId. */
  async importCsv(
    me: AuthenticatedUser,
    csv: unknown,
    now: Date,
  ): Promise<IngestResult & { rows: number }> {
    const companyId = this.changer(me);
    if (typeof csv !== 'string' || !csv.trim()) {
      throw new ValidationError('Paste or upload the CSV text.').withDetails({ field: 'csv' });
    }
    const lines = csv
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim().length);
    if (lines.length < 2)
      throw new ValidationError('The CSV needs a header row and at least one punch.').withDetails({
        field: 'csv',
      });
    if (lines.length - 1 > CSV_MAX_ROWS) {
      throw new ValidationError(
        `At most ${CSV_MAX_ROWS} punches per call: send the file in parts.`,
      ).withDetails({ field: 'csv' });
    }
    const header = csvCells(lines[0]).map((h) => h.toLowerCase());
    const col = (field: string) => header.findIndex((h) => HEADER_ALIASES[field].includes(h));
    const at = {
      code: col('code'),
      time: col('time'),
      direction: col('direction'),
      deviceId: col('deviceId'),
      externalId: col('externalId'),
    };
    if (at.code < 0 || at.time < 0) {
      throw new ValidationError(
        'The header needs a code column and a time column (code,time,direction,deviceId).',
      ).withDetails({ field: 'csv' });
    }
    const inputs = lines.slice(1).map((line) => {
      const c = csvCells(line);
      return {
        code: c[at.code],
        time: c[at.time],
        direction: at.direction >= 0 ? c[at.direction] : undefined,
        deviceId: at.deviceId >= 0 ? c[at.deviceId] : undefined,
        externalId: at.externalId >= 0 ? c[at.externalId] : undefined,
      };
    });
    const total: IngestResult = {
      received: 0,
      stored: 0,
      duplicates: 0,
      unmatched: 0,
      lockedOut: 0,
      daysUpdated: 0,
      ignored: [],
    };
    for (let i = 0; i < inputs.length; i += 500) {
      const r = await this.ingest.ingest(companyId, inputs.slice(i, i + 500), 'CSV', {
        now,
        actorId: me.id,
      });
      total.received += r.received;
      total.stored += r.stored;
      total.duplicates += r.duplicates;
      total.unmatched += r.unmatched;
      total.lockedOut += r.lockedOut;
      total.daysUpdated += r.daysUpdated;
      // Row numbers as the file has them (the header is row 1).
      total.ignored.push(...r.ignored.map((x) => ({ index: x.index + i + 2, reason: x.reason })));
    }
    return { ...total, rows: inputs.length };
  }

  async unmatched(me: AuthenticatedUser) {
    const companyId = this.reader(me);
    const rows = await this.repo.unmatchedCodes(companyId, 500);
    return rows.map((r) => ({
      code: r.code,
      codeKey: r.codeKey,
      punches: r.punches,
      firstAt: r.firstAt.toISOString(),
      lastAt: r.lastAt.toISOString(),
      devices: r.devices,
    }));
  }

  async devices(me: AuthenticatedUser, now: Date) {
    const companyId = this.reader(me);
    const today = startOfDayInZone(dateKeyInZone(now, appTimezone()), appTimezone());
    return (await this.repo.devices(companyId, today)).map((d) => ({
      deviceId: d.deviceId || '(not given)',
      punches: d.punches,
      punchesToday: d.punchesToday,
      lastPunchAt: d.lastPunchAt.toISOString(),
      lastReceivedAt: d.lastReceivedAt.toISOString(),
    }));
  }

  async status(me: AuthenticatedUser, now: Date) {
    const companyId = this.reader(me);
    const tz = appTimezone();
    const today = startOfDayInZone(dateKeyInZone(now, tz), tz);
    const [stats, keys, pull, settings, biometric, everyone, integration] = await Promise.all([
      this.repo.stats(companyId, today),
      this.keys.list(companyId),
      this.settings.pullState(companyId),
      this.settings.get(companyId),
      this.repo.people({ source: 'BIOMETRIC', companyId }),
      this.repo.people({ companyId }),
      // 3.6: the organisation's own switch.
      this.settings.integration(companyId),
    ]);
    return {
      integrationOn: integration.on,
      keys: { active: keys.filter((k) => k.active).length, total: keys.length },
      lastPunchAt: stats.lastPunchAt?.toISOString() ?? null,
      lastReceivedAt: stats.lastReceivedAt?.toISOString() ?? null,
      punchesToday: stats.punchesToday,
      unmatchedCodes: stats.unmatched,
      people: {
        biometric: biometric.length,
        agent: everyone.length - biometric.length,
        withoutCode: biometric.filter((p) => !p.biometricCode).length,
      },
      pull: { enabled: settings.pull.enabled, preset: settings.pull.preset, ...pull },
      pushPath: '/api/v1/biometric/punches',
    };
  }
}
