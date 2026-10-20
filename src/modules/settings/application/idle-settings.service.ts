import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '@shared/database/prisma.service';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { OrgConfigChangedEvent } from '@shared/events/org-config-changed.event';
import { NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { isId } from '@shared/validation/is-id';
import {
  AwayReason,
  DepartmentIdle,
  DepartmentIdleInput,
  IdleRuleProblem,
  ReasonInput,
  applyReasonsUpdate,
  idleFromStored,
  isDefaultDepartmentIdle,
  isIdleMinutes,
  storedReasons,
  validateDepartmentIdle,
} from '../domain/idle.rules';
import { AppSettingsService } from './app-settings.service';

export interface IdleDepartmentView extends DepartmentIdle {
  departmentId: string;
  name: string;
  icon: string;
}

/** GET /idle-settings (docs/4.0/SPEC.md 5.5). */
export interface IdleSettingsView {
  defaultEnabled: boolean;
  defaultMinutes: number;
  reasons: AwayReason[];
  /** Every department of the organisation, with its override (nulls = organisation default). */
  departments: IdleDepartmentView[];
}

export interface IdleSettingsUpdate {
  defaultEnabled: boolean;
  defaultMinutes: number;
  /** Omitted: the reasons stay as they are. */
  reasons?: ReasonInput[];
}

function refuse(p: IdleRuleProblem): never {
  throw new ValidationError(p.message, p.code).withDetails({ field: p.field });
}

/**
 * Input (away) tracking settings of an organisation, stored in its settings row
 * under idleDefaultEnabled, idleDefaultMinutes, idleReasons and departmentIdle.
 * Every write runs one at a time per organisation (single API process), so two
 * department edits never overwrite each other's entry, and announces
 * OrgConfigChangedEvent('IDLE') so agents re-read their config.
 */
@Injectable()
export class IdleSettingsService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly settings: AppSettingsService,
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async get(companyId: string): Promise<IdleSettingsView> {
    const raw = await this.settings.readRaw(companyId);
    return this.view(companyId, raw);
  }

  async update(
    companyId: string,
    input: IdleSettingsUpdate,
    by: string,
  ): Promise<IdleSettingsView> {
    if (typeof input.defaultEnabled !== 'boolean') {
      throw new ValidationError('Choose whether input tracking is on by default.').withDetails({
        field: 'defaultEnabled',
      });
    }
    if (!isIdleMinutes(input.defaultMinutes)) {
      throw new ValidationError('Minutes must be a whole number from 2 to 60.').withDetails({
        field: 'defaultMinutes',
      });
    }
    const raw = await this.serial(companyId, async () => {
      const current = idleFromStored(await this.settings.readRaw(companyId));
      const patch: Record<string, unknown> = {
        idleDefaultEnabled: input.defaultEnabled,
        idleDefaultMinutes: input.defaultMinutes,
      };
      if (input.reasons !== undefined) {
        const next = applyReasonsUpdate(current.reasons, input.reasons);
        if (!next.ok) refuse(next);
        patch.idleReasons = storedReasons(next.value);
        // A department that chose a reason now gone simply stops offering it.
        const known = new Set(next.value.map((r) => r.key));
        patch.departmentIdle = this.storedDepartments(current.departments, (d) => ({
          ...d,
          reasonKeys: d.reasonKeys ? d.reasonKeys.filter((k) => known.has(k)) : null,
        }));
      }
      return this.settings.writeRaw(companyId, patch, by);
    });
    await this.announce(companyId);
    return this.view(companyId, raw);
  }

  async updateDepartment(
    companyId: string,
    departmentId: string,
    input: DepartmentIdleInput,
    by: string,
  ): Promise<IdleSettingsView> {
    await this.assertDepartment(companyId, departmentId);
    const raw = await this.serial(companyId, async () => {
      const current = idleFromStored(await this.settings.readRaw(companyId));
      const checked = validateDepartmentIdle(input, current.reasons);
      if (!checked.ok) refuse(checked);
      const departments = { ...current.departments };
      if (isDefaultDepartmentIdle(checked.value)) delete departments[departmentId];
      else departments[departmentId] = checked.value;
      return this.settings.writeRaw(
        companyId,
        { departmentIdle: this.storedDepartments(departments) },
        by,
      );
    });
    await this.announce(companyId);
    return this.view(companyId, raw);
  }

  /** Drops a deleted department's override (no-op when it had none). */
  async removeDepartment(
    companyId: string,
    departmentId: string,
    by: string | null,
  ): Promise<void> {
    await this.serial(companyId, async () => {
      const current = idleFromStored(await this.settings.readRaw(companyId));
      if (!current.departments[departmentId]) return;
      const departments = { ...current.departments };
      delete departments[departmentId];
      await this.settings.writeRaw(
        companyId,
        { departmentIdle: this.storedDepartments(departments) },
        by,
      );
    });
  }

  /** Agents re-read config.idle on this (GET /workday/me/today). */
  async announce(companyId: string): Promise<void> {
    await this.events.publish(
      OrgConfigChangedEvent.eventName,
      new OrgConfigChangedEvent(companyId, 'IDLE', new Date()),
    );
  }

  private async assertDepartment(companyId: string, departmentId: string): Promise<void> {
    const found = isId(departmentId)
      ? await this.prisma.department.findFirst({
          where: { id: departmentId, companyId, deletedAt: null },
          select: { id: true },
        })
      : null;
    if (!found) throw new NotFoundError('That department does not exist.', 'DEPARTMENT_NOT_FOUND');
  }

  private storedDepartments(
    departments: Record<string, DepartmentIdle>,
    map: (d: DepartmentIdle) => DepartmentIdle = (d) => d,
  ): Record<string, DepartmentIdle> {
    const out: Record<string, DepartmentIdle> = {};
    for (const [id, d] of Object.entries(departments)) {
      const next = map(d);
      if (!isDefaultDepartmentIdle(next)) out[id] = next;
    }
    return out;
  }

  private async view(companyId: string, raw: Record<string, unknown>): Promise<IdleSettingsView> {
    const idle = idleFromStored(raw);
    const departments = await this.prisma.department.findMany({
      where: { companyId, deletedAt: null },
      select: { id: true, name: true, icon: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      defaultEnabled: idle.defaultEnabled,
      defaultMinutes: idle.defaultMinutes,
      reasons: idle.reasons,
      departments: departments.map((d) => {
        const own = idle.departments[d.id];
        return {
          departmentId: d.id,
          name: d.name,
          icon: d.icon,
          enabled: own?.enabled ?? null,
          minutes: own?.minutes ?? null,
          reasonKeys: own?.reasonKeys ?? null,
        };
      }),
    };
  }

  /** Runs `fn` after every earlier write of the same organisation has finished. */
  private serial<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(companyId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.queues.set(companyId, tail);
    void tail.then(() => {
      if (this.queues.get(companyId) === tail) this.queues.delete(companyId);
    });
    return run;
  }
}
