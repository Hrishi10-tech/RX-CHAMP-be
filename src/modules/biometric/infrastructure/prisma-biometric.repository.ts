import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import {
  lockUser,
  markDayEnded,
} from '@modules/worktime/infrastructure/prisma-work-session.repository';
import {
  AttendanceWrite,
  BiometricPerson,
  BiometricRepository,
  DeviceSeen,
  KeyRecord,
  NewPunch,
  PunchFilter,
  PunchRecord,
  ReplaceDayResult,
  UnmatchedCode,
} from '../domain/biometric.repository';
import { PlannedSession, PunchSource } from '../domain/punch';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuids = (ids: string[]) => [...new Set(ids)].filter((id) => UUID.test(id));
/** A company id as a filter: one that is not a UUID matches nothing. */
const org = (companyId: string) =>
  UUID.test(companyId) ? companyId : '00000000-0000-0000-0000-000000000000';

type PunchRow = Prisma.BiometricPunchGetPayload<object>;

function toPunch(r: PunchRow): PunchRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    code: r.code,
    codeKey: r.codeKey,
    punchedAt: r.punchedAt,
    direction: r.direction === 'IN' || r.direction === 'OUT' ? r.direction : null,
    deviceId: r.deviceId,
    externalId: r.externalId,
    source: r.source as PunchSource,
    userId: r.userId,
    dayKey: r.dayKey,
    note: r.note,
    createdById: r.createdById,
    keyId: r.keyId,
    lockedOut: r.lockedOut,
    voidedAt: r.voidedAt,
    voidedById: r.voidedById,
    voidReason: r.voidReason,
    receivedAt: r.receivedAt,
  };
}

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  department: true,
  companyId: true,
  company: { select: { name: true } },
  managerId: true,
  role: { select: { name: true } },
  attendanceSource: true,
  biometricCode: true,
  attendanceSourceFrom: true,
} as const;

type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON_SELECT }>;

function toPerson(r: PersonRow): BiometricPerson {
  return {
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    role: r.role.name,
    department: r.department,
    companyId: r.companyId,
    companyName: r.company?.name ?? null,
    managerId: r.managerId,
    attendanceSource: r.attendanceSource === 'BIOMETRIC' ? 'BIOMETRIC' : 'AGENT',
    biometricCode: r.biometricCode,
    attendanceSourceFrom: r.attendanceSourceFrom,
  };
}

function toKey(r: Prisma.BiometricKeyGetPayload<object>): KeyRecord {
  return {
    id: r.id,
    companyId: r.companyId,
    name: r.name,
    prefix: r.prefix,
    createdById: r.createdById,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    lastUsedIp: r.lastUsedIp,
    revokedAt: r.revokedAt,
  };
}

@Injectable()
export class PrismaBiometricRepository implements BiometricRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Punches ----------------------------------------------------------------

  async insertPunches(rows: NewPunch[]): Promise<{ inserted: PunchRecord[]; duplicates: number }> {
    if (!rows.length) return { inserted: [], duplicates: 0 };
    const inserted: PunchRecord[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const created = await this.prisma.biometricPunch.createManyAndReturn({
        data: chunk,
        skipDuplicates: true,
      });
      inserted.push(...created.map(toPunch));
    }
    return { inserted, duplicates: rows.length - inserted.length };
  }

  async findPunch(id: string): Promise<PunchRecord | null> {
    if (!UUID.test(id)) return null;
    const row = await this.prisma.biometricPunch.findUnique({ where: { id } });
    return row ? toPunch(row) : null;
  }

  async voidPunch(id: string, byId: string, reason: string, at: Date): Promise<PunchRecord> {
    return toPunch(
      await this.prisma.biometricPunch.update({
        where: { id },
        data: { voidedAt: at, voidedById: byId, voidReason: reason },
      }),
    );
  }

  async listPunches(f: PunchFilter): Promise<{ items: PunchRecord[]; total: number }> {
    const where: Prisma.BiometricPunchWhereInput = {
      companyId: org(f.companyId),
      ...(f.from || f.to
        ? { punchedAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } }
        : {}),
      ...(f.userId
        ? { userId: UUID.test(f.userId) ? f.userId : '00000000-0000-0000-0000-000000000000' }
        : {}),
      ...(f.codeKey ? { codeKey: f.codeKey } : {}),
      ...(f.deviceId !== undefined ? { deviceId: f.deviceId } : {}),
      ...(f.unmatchedOnly ? { userId: null } : {}),
      ...(f.includeVoided ? {} : { voidedAt: null }),
    };
    const [items, total] = await Promise.all([
      this.prisma.biometricPunch.findMany({
        where,
        orderBy: [{ punchedAt: 'desc' }, { id: 'asc' }],
        take: Math.min(2000, Math.max(1, f.limit ?? 300)),
      }),
      this.prisma.biometricPunch.count({ where }),
    ]);
    return { items: items.map(toPunch), total };
  }

  async punchesOfDays(userId: string, dayKeys: string[]): Promise<PunchRecord[]> {
    if (!UUID.test(userId) || !dayKeys.length) return [];
    const rows = await this.prisma.biometricPunch.findMany({
      where: { userId, dayKey: { in: [...new Set(dayKeys)] } },
      orderBy: { punchedAt: 'asc' },
    });
    return rows.map(toPunch);
  }

  async punchesWithCodes(companyId: string, codeKeys: string[]): Promise<PunchRecord[]> {
    const keys = [...new Set(codeKeys)].filter(Boolean);
    if (!keys.length) return [];
    const rows = await this.prisma.biometricPunch.findMany({
      where: { companyId: org(companyId), codeKey: { in: keys } },
      orderBy: { punchedAt: 'asc' },
      take: 200_000,
    });
    return rows.map(toPunch);
  }

  async setPunchOwner(
    rows: { id: string; userId: string | null; dayKey: string; lockedOut: boolean }[],
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += 200) {
      await this.prisma.$transaction(
        rows.slice(i, i + 200).map((r) =>
          this.prisma.biometricPunch.update({
            where: { id: r.id },
            data: { userId: r.userId, dayKey: r.dayKey, lockedOut: r.lockedOut },
          }),
        ),
      );
    }
  }

  async unmatchedCodes(companyId: string, limit: number): Promise<UnmatchedCode[]> {
    const rows = await this.prisma.$queryRaw<
      {
        code_key: string;
        code: string;
        punches: number;
        first_at: Date;
        last_at: Date;
        devices: string[];
      }[]
    >`
      SELECT code_key, min(code) AS code, count(*)::int AS punches,
             min(punched_at) AS first_at, max(punched_at) AS last_at,
             array_remove(array_agg(DISTINCT NULLIF(device_id, '')), NULL) AS devices
      FROM biometric_punches
      WHERE company_id = ${org(companyId)}::uuid AND user_id IS NULL AND voided_at IS NULL
      GROUP BY code_key
      ORDER BY max(punched_at) DESC
      LIMIT ${Math.max(1, Math.min(1000, limit))}`;
    return rows.map((r) => ({
      codeKey: r.code_key,
      code: r.code,
      punches: r.punches,
      firstAt: r.first_at,
      lastAt: r.last_at,
      devices: r.devices ?? [],
    }));
  }

  async devices(companyId: string, todayFrom: Date): Promise<DeviceSeen[]> {
    const rows = await this.prisma.$queryRaw<
      { device_id: string; punches: number; today: number; last_at: Date; last_received: Date }[]
    >`
      SELECT device_id, count(*)::int AS punches,
             count(*) FILTER (WHERE punched_at >= ${todayFrom})::int AS today,
             max(punched_at) AS last_at, max(received_at) AS last_received
      FROM biometric_punches
      WHERE company_id = ${org(companyId)}::uuid AND voided_at IS NULL
      GROUP BY device_id
      ORDER BY max(received_at) DESC
      LIMIT 500`;
    return rows.map((r) => ({
      deviceId: r.device_id,
      punches: r.punches,
      punchesToday: r.today,
      lastPunchAt: r.last_at,
      lastReceivedAt: r.last_received,
    }));
  }

  async stats(
    companyId: string,
    todayFrom: Date,
  ): Promise<{
    lastPunchAt: Date | null;
    lastReceivedAt: Date | null;
    punchesToday: number;
    unmatched: number;
  }> {
    const rows = await this.prisma.$queryRaw<
      { last_at: Date | null; last_received: Date | null; today: number; unmatched: number }[]
    >`
      SELECT max(punched_at) AS last_at, max(received_at) AS last_received,
             count(*) FILTER (WHERE punched_at >= ${todayFrom})::int AS today,
             count(DISTINCT code_key) FILTER (WHERE user_id IS NULL)::int AS unmatched
      FROM biometric_punches
      WHERE company_id = ${org(companyId)}::uuid AND voided_at IS NULL`;
    const r = rows[0];
    return {
      lastPunchAt: r?.last_at ?? null,
      lastReceivedAt: r?.last_received ?? null,
      punchesToday: r?.today ?? 0,
      unmatched: r?.unmatched ?? 0,
    };
  }

  // ---- People -----------------------------------------------------------------

  async people(filter: {
    search?: string;
    companyId: string;
    source?: 'AGENT' | 'BIOMETRIC';
    ids?: string[];
  }): Promise<BiometricPerson[]> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status: 'ACTIVE',
      companyId: org(filter.companyId),
    };
    if (filter.source) where.attendanceSource = filter.source;
    if (filter.ids) where.id = { in: uuids(filter.ids) };
    if (filter.search) {
      const q = filter.search.trim();
      where.OR = [
        { firstName: { contains: q, mode: 'insensitive' } },
        { lastName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { biometricCode: { contains: q.toUpperCase() } },
      ];
    }
    const rows = await this.prisma.user.findMany({
      where,
      select: PERSON_SELECT,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 2000,
    });
    return rows.map(toPerson);
  }

  async names(ids: string[]): Promise<Map<string, { firstName: string; lastName: string }>> {
    const list = uuids(ids);
    if (!list.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: list } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(rows.map((r) => [r.id, r] as const));
  }

  async peopleByCodes(
    companyId: string,
    codeKeys: string[],
  ): Promise<Map<string, BiometricPerson>> {
    const keys = [...new Set(codeKeys)].filter(Boolean);
    if (!keys.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { companyId: org(companyId), biometricCode: { in: keys }, deletedAt: null },
      select: PERSON_SELECT,
    });
    return new Map(rows.map((r) => [r.biometricCode!, toPerson(r)]));
  }

  async setAttendance(rows: AttendanceWrite[]): Promise<void> {
    if (!rows.length) return;
    await this.prisma.$transaction(async (tx) => {
      // Codes move first to nobody, so swapping two people's codes never trips the unique index.
      await tx.user.updateMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        data: { biometricCode: null },
      });
      for (const r of rows) {
        await tx.user.update({
          where: { id: r.userId },
          data: {
            attendanceSource: r.attendanceSource,
            biometricCode: r.biometricCode,
            attendanceSourceFrom: r.attendanceSourceFrom,
          },
        });
      }
    });
  }

  async lastPunchOf(userIds: string[]): Promise<Map<string, Date>> {
    const ids = uuids(userIds);
    if (!ids.length) return new Map();
    const rows = await this.prisma.biometricPunch.groupBy({
      by: ['userId'],
      where: { userId: { in: ids }, voidedAt: null },
      _max: { punchedAt: true },
    });
    return new Map(
      rows
        .filter((r) => r.userId && r._max.punchedAt)
        .map((r) => [r.userId!, r._max.punchedAt!] as const),
    );
  }

  // ---- Keys -------------------------------------------------------------------

  async createKey(data: {
    companyId: string;
    name: string;
    prefix: string;
    hash: string;
    createdById: string;
  }): Promise<KeyRecord> {
    return toKey(await this.prisma.biometricKey.create({ data }));
  }

  async listKeys(companyId: string): Promise<KeyRecord[]> {
    const rows = await this.prisma.biometricKey.findMany({
      where: { companyId: org(companyId) },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toKey);
  }

  async findKeyByHash(hash: string): Promise<KeyRecord | null> {
    const row = await this.prisma.biometricKey.findUnique({ where: { hash } });
    return row ? toKey(row) : null;
  }

  async touchKey(id: string, at: Date, ip: string | null): Promise<void> {
    await this.prisma.biometricKey.update({
      where: { id },
      data: { lastUsedAt: at, lastUsedIp: ip },
    });
  }

  async revokeKey(companyId: string, id: string, byId: string, at: Date): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const res = await this.prisma.biometricKey.updateMany({
      where: { id, companyId: org(companyId), revokedAt: null },
      data: { revokedAt: at, revokedById: byId },
    });
    return res.count > 0;
  }

  // ---- Days -------------------------------------------------------------------

  async replaceDay(
    userId: string,
    dayKey: string,
    planned: PlannedSession[],
    lastPunchAt: Date | null,
  ): Promise<ReplaceDayResult> {
    return this.prisma.$transaction(
      async (tx) => {
        await lockUser(tx, userId);
        const existing = await tx.workSession.findMany({
          where: { userId, date: dayKey, source: 'BIOMETRIC' },
          orderBy: { startedAt: 'asc' },
        });
        const wasOpen = existing.some((s) => s.endedAt === null);
        const late = existing[0]?.lateReason
          ? { lateReason: existing[0].lateReason, lateReasonAt: existing[0].lateReasonAt }
          : {};
        const plan = planned.map((p) => ({ ...p }));
        const firstStart = plan[0]?.startedAt ?? null;
        let closedWfhAt: Date | null = null;

        const others = await tx.workSession.findMany({
          where: { userId, endedAt: null, NOT: { date: dayKey, source: 'BIOMETRIC' } },
        });
        for (const o of others) {
          if (o.source === 'BIOMETRIC' && o.date < dayKey) {
            // An earlier biometric day that never got its check-out closes at its last punch.
            const last = await tx.biometricPunch.findFirst({
              where: { userId, dayKey: o.date, voidedAt: null },
              orderBy: { punchedAt: 'desc' },
            });
            const end = last && last.punchedAt > o.startedAt ? last.punchedAt : o.startedAt;
            await tx.workSession.update({
              where: { id: o.id },
              data: { endedAt: end, endReason: 'AUTO_CLOSED' },
            });
            await markDayEnded(tx, userId, o.date, end);
          } else if (o.source === 'MOBILE_WFH' && firstStart && firstStart > o.startedAt) {
            // A punch at the office after work from home started on the phone ends it there.
            await tx.workSession.update({
              where: { id: o.id },
              data: { endedAt: firstStart, endReason: 'USER' },
            });
            closedWfhAt = firstStart;
          }
        }
        // Anything still open elsewhere (the phone, or the agent before a switch) wins:
        // this day then closes at its last punch instead of staying open.
        const stillOpen = await tx.workSession.count({
          where: { userId, endedAt: null, NOT: { date: dayKey, source: 'BIOMETRIC' } },
        });
        if (stillOpen) {
          for (const p of plan) {
            if (p.endedAt === null) {
              p.endedAt = lastPunchAt && lastPunchAt > p.startedAt ? lastPunchAt : p.startedAt;
              p.endReason = 'USER';
            }
          }
        }

        await tx.workSession.deleteMany({ where: { userId, date: dayKey, source: 'BIOMETRIC' } });
        if (plan.length) {
          await tx.workSession.createMany({
            data: plan.map((p, i) => ({
              userId,
              date: dayKey,
              startedAt: p.startedAt,
              endedAt: p.endedAt,
              endReason: p.endReason,
              source: 'BIOMETRIC',
              ...(i === 0 ? late : {}),
            })),
          });
        }
        const open = plan.some((p) => p.endedAt === null);
        let newlyEnded = false;
        if (open) {
          await tx.workDayEnd.updateMany({
            where: { userId, date: dayKey },
            data: { endedAt: null },
          });
        } else if (plan.length) {
          const end = plan.reduce(
            (m, p) => (p.endedAt && p.endedAt > m ? p.endedAt : m),
            plan[0].endedAt as Date,
          );
          newlyEnded = await markDayEnded(tx, userId, dayKey, end);
        }
        const same =
          existing.length === plan.length &&
          existing.every(
            (e, i) =>
              e.startedAt.getTime() === plan[i].startedAt.getTime() &&
              (e.endedAt?.getTime() ?? null) === (plan[i].endedAt?.getTime() ?? null),
          );
        return {
          changed: !same || wasOpen !== open,
          wasOpen,
          open,
          wasEmpty: existing.length === 0,
          newlyEnded,
          closedWfhAt,
        };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  async openDays(): Promise<{ userId: string; date: string; startedAt: Date }[]> {
    return this.prisma.workSession.findMany({
      where: { endedAt: null, source: 'BIOMETRIC' },
      select: { userId: true, date: true, startedAt: true },
      take: 10_000,
    });
  }

  async lockedMonths(companyId: string, months: string[]): Promise<Set<string>> {
    const list = [...new Set(months)];
    if (!list.length) return new Set();
    const rows = await this.prisma.monthLock.findMany({
      where: { companyId: org(companyId), month: { in: list } },
      select: { month: true },
    });
    return new Set(rows.map((r) => r.month));
  }

  async companyIds(): Promise<string[]> {
    const rows = await this.prisma.company.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
}
