import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { dateKeyInZone } from '@shared/utils/timezone';
import { validateShiftDefinition } from '../../domain/break-schedule';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '../../domain/shift-people.reader';
import { SHIFT_REPOSITORY, ShiftRepository, ShiftWriteData } from '../../domain/shift.repository';
import { BREAK_KINDS, ShiftRecord, defaultAllowSkip } from '../../domain/shift.types';
import { BreakDayService } from '../break-day.service';
import { UpsertShiftDto } from '../dto';
import { ShiftMapper } from '../shift.mapper';
import { ShiftValidationView, ShiftView } from '../shifts.types';

const RULE_DEFAULTS = {
  ringLeadMin: 1,
  ringDurationMin: 5,
  ringSound: true,
  reasonOnEarly: true,
  reasonOnLate: true,
  reasonMinChars: 10,
  overrunReason: false,
  // 3.1: up to 3 minutes over a break is simply break time.
  overrunGraceMin: 3,
};

/**
 * Shift definitions. Super Admin creates, edits, deletes and picks the default;
 * Managers may read them (to override a shift for their own staff).
 */
@Injectable()
export class ManageShiftsUseCase {
  constructor(
    @Inject(SHIFT_REPOSITORY) private readonly shifts: ShiftRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
  ) {}

  private assertSuperAdmin(me: AuthenticatedUser): void {
    if (me.role !== Role.SUPER_ADMIN)
      throw new ForbiddenError('Only a Super Admin can change shifts.');
  }

  async list(me: AuthenticatedUser): Promise<ShiftView[]> {
    if (me.role === Role.USER) throw new ForbiddenError('Not allowed');
    const all = await this.shifts.list();
    const usage = await this.usageFor(all);
    return all.map((s) => ShiftMapper.shiftView(s, usage.get(s.id) ?? emptyUsage()));
  }

  async get(me: AuthenticatedUser, id: string): Promise<ShiftView> {
    if (me.role === Role.USER) throw new ForbiddenError('Not allowed');
    const shift = await this.shifts.findById(id);
    if (!shift) throw new NotFoundError('Unknown shift');
    const usage = await this.usageFor([shift]);
    return ShiftMapper.shiftView(shift, usage.get(shift.id) ?? emptyUsage());
  }

  async create(me: AuthenticatedUser, dto: UpsertShiftDto): Promise<ShiftView> {
    this.assertSuperAdmin(me);
    const data = await this.toWriteData(dto);
    if (await this.shifts.findByName(data.companyId, data.name)) {
      throw new ConflictError(`A shift called '${data.name.trim()}' already exists`);
    }
    const created = await this.shifts.create(data);
    // The first shift of all becomes the default, so nobody is left with none.
    if ((await this.shifts.listDefaults()).length === 0) await this.shifts.setDefault(created.id);
    this.days.invalidate();
    return this.get(me, created.id);
  }

  async update(me: AuthenticatedUser, id: string, dto: UpsertShiftDto): Promise<ShiftView> {
    this.assertSuperAdmin(me);
    const existing = await this.shifts.findById(id);
    if (!existing) throw new NotFoundError('Unknown shift');
    const data = await this.toWriteData(dto);
    const clash = await this.shifts.findByName(data.companyId, data.name);
    if (clash && clash.id !== id) {
      throw new ConflictError(`A shift called '${data.name.trim()}' already exists`);
    }
    await this.shifts.update(id, data);
    this.days.invalidate();
    return this.get(me, id);
  }

  async remove(me: AuthenticatedUser, id: string): Promise<{ deleted: true; id: string }> {
    this.assertSuperAdmin(me);
    const shift = await this.shifts.findById(id);
    if (!shift) throw new NotFoundError('Unknown shift');
    if (shift.isDefault) {
      throw new ConflictError(
        'This is the default shift. Make another shift the default first.',
        'SHIFT_IS_DEFAULT',
      );
    }
    const usage = await this.shifts.usage(id, dateKeyInZone(new Date(), this.days.timezone));
    if (usage.activeAssignments > 0) {
      throw new ConflictError(
        `This shift is still assigned (${usage.activeAssignments} department or staff assignment` +
          `${usage.activeAssignments === 1 ? '' : 's'}). Move them to another shift first.`,
        'SHIFT_IN_USE',
      );
    }
    await this.shifts.softDelete(id);
    this.days.invalidate();
    return { deleted: true, id };
  }

  async makeDefault(me: AuthenticatedUser, id: string): Promise<ShiftView> {
    this.assertSuperAdmin(me);
    const shift = await this.shifts.findById(id);
    if (!shift) throw new NotFoundError('Unknown shift');
    await this.shifts.setDefault(id);
    this.days.invalidate();
    return this.get(me, id);
  }

  /** Checks a definition without saving; the editor shows the problems and derived times live. */
  async validate(dto: UpsertShiftDto): Promise<ShiftValidationView> {
    const { data, problems } = this.buildWriteData(dto);
    const preview: ShiftRecord = {
      ...data,
      id: 'preview',
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return {
      valid: problems.length === 0,
      problems,
      breaks: data.breaks.map((b) => ShiftMapper.breakView(b, preview)),
    };
  }

  private async toWriteData(dto: UpsertShiftDto): Promise<ShiftWriteData> {
    const companyId = dto.companyId ?? null;
    if (companyId && !(await this.shifts.companyExists(companyId))) {
      throw new ValidationError('Unknown company');
    }
    const { data, problems } = this.buildWriteData(dto);
    if (problems.length)
      throw new ValidationError(problems.join(' '), 'SHIFT_INVALID').withDetails({ problems });
    return data;
  }

  private buildWriteData(dto: UpsertShiftDto): { data: ShiftWriteData; problems: string[] } {
    const companyId = dto.companyId ?? null;
    const breaks = BREAK_KINDS.map((kind) => dto.breaks.find((b) => b.kind === kind))
      .filter((b): b is NonNullable<typeof b> => !!b)
      .map((b) => ({ ...b, allowSkip: b.allowSkip ?? defaultAllowSkip(b.kind) }));
    const duplicate = breaks.length !== dto.breaks.length;
    const data: ShiftWriteData = {
      companyId,
      name: dto.name.trim(),
      start: dto.start,
      end: dto.end,
      workDays: dto.workDays,
      ringLeadMin: dto.ringLeadMin ?? RULE_DEFAULTS.ringLeadMin,
      ringDurationMin: dto.ringDurationMin ?? RULE_DEFAULTS.ringDurationMin,
      ringSound: dto.ringSound ?? RULE_DEFAULTS.ringSound,
      reasonOnEarly: dto.reasonOnEarly ?? RULE_DEFAULTS.reasonOnEarly,
      reasonOnLate: dto.reasonOnLate ?? RULE_DEFAULTS.reasonOnLate,
      reasonMinChars: dto.reasonMinChars ?? RULE_DEFAULTS.reasonMinChars,
      overrunReason: dto.overrunReason ?? RULE_DEFAULTS.overrunReason,
      overrunGraceMin: dto.overrunGraceMin ?? RULE_DEFAULTS.overrunGraceMin,
      breaks,
    };
    const problems = validateShiftDefinition(data);
    if (duplicate) problems.unshift('Each break (morning, lunch, evening) can appear once.');
    return { data, problems };
  }

  /** Who each shift applies to today (people, departments, overrides). */
  private async usageFor(shifts: ShiftRecord[]): Promise<Map<string, ShiftView['usage']>> {
    const now = new Date();
    const today = dateKeyInZone(now, this.days.timezone);
    const people = await this.people.listAllActive();
    const ctx = await this.days.context(people.map((p) => p.id));
    const out = new Map<string, ShiftView['usage']>();
    for (const s of shifts) out.set(s.id, emptyUsage());

    for (const p of people) {
      const r = this.days.resolveWith(ctx, p, today);
      if (!r.shift) continue;
      const u = out.get(r.shift.id);
      if (!u) continue;
      u.people += 1;
      if (r.source === 'OVERRIDE') u.overrides += 1;
    }

    const seen = new Set<string>();
    const deptRows = ctx.assignments
      .filter((a) => a.target === 'DEPARTMENT' && a.effectiveFrom <= today)
      .sort((a, b) =>
        a.effectiveFrom === b.effectiveFrom
          ? b.createdAt.getTime() - a.createdAt.getTime()
          : a.effectiveFrom < b.effectiveFrom
            ? 1
            : -1,
      );
    for (const a of deptRows) {
      const key = `${a.companyId ?? '-'}|${a.departmentKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (a.shiftId && out.has(a.shiftId) && a.department)
        out.get(a.shiftId)!.departments.push(a.department);
    }
    return out;
  }
}

function emptyUsage(): ShiftView['usage'] {
  return { people: 0, departments: [], overrides: 0 };
}
