import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@shared/database/prisma.service';
import { addDaysToKey } from '@shared/utils/timezone';
import {
  NewAssignment,
  ShiftRepository,
  ShiftUsage,
  ShiftWriteData,
} from '../domain/shift.repository';
import {
  BREAK_KINDS,
  BreakKind,
  ShiftAssignmentRecord,
  ShiftBreakDef,
  ShiftRecord,
  breakAllowsSkip,
} from '../domain/shift.types';

const WITH_BREAKS = { breaks: true } as const;
type ShiftRow = Prisma.ShiftGetPayload<{ include: typeof WITH_BREAKS }>;

@Injectable()
export class PrismaShiftRepository implements ShiftRepository {
  constructor(private readonly prisma: PrismaService) {}

  private toRecord(row: ShiftRow): ShiftRecord {
    const breaks: ShiftBreakDef[] = BREAK_KINDS.map((kind) =>
      row.breaks.find((b) => b.kind === kind),
    )
      .filter((b): b is NonNullable<typeof b> => !!b)
      .map((b) => ({
        kind: b.kind as BreakKind,
        enabled: b.enabled,
        startTime: b.startTime,
        durationMin: b.durationMin,
        windowBeforeMin: b.windowBeforeMin,
        windowAfterMin: b.windowAfterMin,
        allowSkip: b.allowSkip,
      }));
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      start: row.start,
      end: row.end,
      workDays: row.workDays?.length ? row.workDays : [1, 2, 3, 4, 5, 6],
      isDefault: row.isDefault,
      ringLeadMin: row.ringLeadMin,
      ringDurationMin: row.ringDurationMin,
      ringSound: row.ringSound,
      reasonOnEarly: row.reasonOnEarly,
      reasonOnLate: row.reasonOnLate,
      reasonMinChars: row.reasonMinChars,
      overrunReason: row.overrunReason,
      overrunGraceMin: row.overrunGraceMin,
      breaks,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private columns(data: ShiftWriteData) {
    return {
      companyId: data.companyId,
      name: data.name.trim(),
      start: data.start,
      end: data.end,
      workDays: [...new Set(data.workDays)].sort((a, b) => a - b),
      ringLeadMin: data.ringLeadMin,
      ringDurationMin: data.ringDurationMin,
      ringSound: data.ringSound,
      reasonOnEarly: data.reasonOnEarly,
      reasonOnLate: data.reasonOnLate,
      reasonMinChars: data.reasonMinChars,
      overrunReason: data.overrunReason,
      overrunGraceMin: data.overrunGraceMin,
    };
  }

  private breakRows(data: ShiftWriteData) {
    return data.breaks.map((b) => ({
      kind: b.kind,
      enabled: b.enabled,
      startTime: b.startTime,
      durationMin: b.durationMin,
      windowBeforeMin: b.windowBeforeMin,
      windowAfterMin: b.windowAfterMin,
      allowSkip: breakAllowsSkip(b),
    }));
  }

  async list(): Promise<ShiftRecord[]> {
    const rows = await this.prisma.shift.findMany({
      where: { deletedAt: null },
      include: WITH_BREAKS,
      orderBy: [{ isDefault: 'desc' }, { start: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => this.toRecord(r));
  }

  async findById(id: string): Promise<ShiftRecord | null> {
    if (!isUuid(id)) return null;
    const row = await this.prisma.shift.findFirst({
      where: { id, deletedAt: null },
      include: WITH_BREAKS,
    });
    return row ? this.toRecord(row) : null;
  }

  async findByName(companyId: string | null, name: string): Promise<ShiftRecord | null> {
    const row = await this.prisma.shift.findFirst({
      where: {
        deletedAt: null,
        companyId,
        name: { equals: name.trim(), mode: 'insensitive' },
      },
      include: WITH_BREAKS,
    });
    return row ? this.toRecord(row) : null;
  }

  async create(data: ShiftWriteData): Promise<ShiftRecord> {
    const row = await this.prisma.shift.create({
      data: { ...this.columns(data), breaks: { create: this.breakRows(data) } },
      include: WITH_BREAKS,
    });
    return this.toRecord(row);
  }

  async update(id: string, data: ShiftWriteData): Promise<ShiftRecord> {
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.shiftBreak.deleteMany({ where: { shiftId: id } });
      return tx.shift.update({
        where: { id },
        data: { ...this.columns(data), breaks: { create: this.breakRows(data) } },
        include: WITH_BREAKS,
      });
    });
    return this.toRecord(row);
  }

  /**
   * Serialises shift name checks within one organisation (or the shared scope) for
   * the rest of the transaction, so two writes of the same name cannot both pass
   * the check (no unique index: older databases may hold duplicates already).
   */
  private async lockNames(tx: Prisma.TransactionClient, companyId: string | null): Promise<void> {
    const key = `rxv:shift-name:${companyId ?? 'shared'}`;
    await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${key}))) AS l`;
  }

  private nameClash(
    tx: Prisma.TransactionClient,
    companyId: string | null,
    name: string,
    exceptId?: string,
  ) {
    return tx.shift.findFirst({
      where: {
        deletedAt: null,
        companyId,
        name: { equals: name.trim(), mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
  }

  async createUnique(
    data: ShiftWriteData,
  ): Promise<{ ok: true; shift: ShiftRecord } | { ok: false }> {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockNames(tx, data.companyId);
      if (await this.nameClash(tx, data.companyId, data.name)) return null;
      const created = await tx.shift.create({
        data: { ...this.columns(data), breaks: { create: this.breakRows(data) } },
        include: WITH_BREAKS,
      });
      // An organisation's first shift becomes its default (under the same lock).
      if (data.companyId) {
        const hasDefault = await tx.shift.findFirst({
          where: { companyId: data.companyId, isDefault: true, deletedAt: null },
          select: { id: true },
        });
        if (!hasDefault) {
          return tx.shift.update({
            where: { id: created.id },
            data: { isDefault: true },
            include: WITH_BREAKS,
          });
        }
      }
      return created;
    });
    return row ? { ok: true, shift: this.toRecord(row) } : { ok: false };
  }

  async updateUnique(
    id: string,
    data: ShiftWriteData,
  ): Promise<{ ok: true; shift: ShiftRecord } | { ok: false }> {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockNames(tx, data.companyId);
      if (await this.nameClash(tx, data.companyId, data.name, id)) return null;
      await tx.shiftBreak.deleteMany({ where: { shiftId: id } });
      return tx.shift.update({
        where: { id },
        data: { ...this.columns(data), breaks: { create: this.breakRows(data) } },
        include: WITH_BREAKS,
      });
    });
    return row ? { ok: true, shift: this.toRecord(row) } : { ok: false };
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.shift.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false },
    });
  }

  async setDefault(id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const shift = await tx.shift.findUniqueOrThrow({ where: { id } });
      await tx.shift.updateMany({
        where: { companyId: shift.companyId, isDefault: true, NOT: { id } },
        data: { isDefault: false },
      });
      await tx.shift.update({ where: { id }, data: { isDefault: true } });
    });
  }

  async listDefaults(): Promise<ShiftRecord[]> {
    const rows = await this.prisma.shift.findMany({
      where: { deletedAt: null, isDefault: true },
      include: WITH_BREAKS,
    });
    return rows.map((r) => this.toRecord(r));
  }

  async usage(id: string, todayKey: string): Promise<ShiftUsage> {
    const activeAssignments = await this.prisma.shiftAssignment.count({
      where: {
        shiftId: id,
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: todayKey } }],
      },
    });
    return { activeAssignments };
  }

  async companyExists(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const c = await this.prisma.company.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    return c !== null;
  }

  async applyAssignments(rows: NewAssignment[]): Promise<void> {
    if (!rows.length) return;
    await this.prisma.$transaction(
      async (tx) => {
        for (const row of rows) {
          const sameTarget: Prisma.ShiftAssignmentWhereInput =
            row.target === 'USER'
              ? { target: 'USER', userId: row.userId }
              : {
                  target: 'DEPARTMENT',
                  companyId: row.companyId,
                  departmentKey: row.departmentKey,
                };
          const overlapping = await tx.shiftAssignment.findMany({
            where: {
              ...sameTarget,
              effectiveFrom: row.effectiveTo
                ? { gte: row.effectiveFrom, lte: row.effectiveTo }
                : { gte: row.effectiveFrom },
            },
            select: { id: true, effectiveTo: true },
          });
          const remove: string[] = [];
          for (const o of overlapping) {
            const endsInside =
              row.effectiveTo !== null &&
              o.effectiveTo !== null &&
              o.effectiveTo <= row.effectiveTo;
            if (row.effectiveTo === null || endsInside) {
              remove.push(o.id);
            } else {
              // Starts inside the new span but runs past it: keep the part after.
              await tx.shiftAssignment.update({
                where: { id: o.id },
                data: { effectiveFrom: addDaysToKey(row.effectiveTo, 1) },
              });
            }
          }
          if (remove.length) await tx.shiftAssignment.deleteMany({ where: { id: { in: remove } } });
          await tx.shiftAssignment.create({ data: row });
        }
      },
      { timeout: 30_000 },
    );
  }

  async listAssignmentsFor(userIds: string[]): Promise<ShiftAssignmentRecord[]> {
    const rows = await this.prisma.shiftAssignment.findMany({
      where: {
        OR: [
          { target: 'DEPARTMENT' },
          ...(userIds.length ? [{ target: 'USER' as const, userId: { in: userIds } }] : []),
        ],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toAssignment);
  }

  async listAllAssignments(): Promise<ShiftAssignmentRecord[]> {
    const rows = await this.prisma.shiftAssignment.findMany({
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toAssignment);
  }

  async listDepartmentAssignments(): Promise<ShiftAssignmentRecord[]> {
    const rows = await this.prisma.shiftAssignment.findMany({
      where: { target: 'DEPARTMENT' },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toAssignment);
  }
}

function toAssignment(r: Prisma.ShiftAssignmentGetPayload<object>): ShiftAssignmentRecord {
  return {
    id: r.id,
    target: r.target,
    companyId: r.companyId,
    department: r.department,
    departmentKey: r.departmentKey,
    userId: r.userId,
    shiftId: r.shiftId,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    createdById: r.createdById,
    createdAt: r.createdAt,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID.test(value);
}
