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
import { Role, seesEveryOrg } from '@shared/rbac/roles.enum';
import { canSeePerson, orgInView, requireOrg, seesWholeOrg } from '@shared/tenancy';
import { addDaysToKey, appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import {
  ADJUSTMENT_MAX_AGE_DAYS,
  checkAdjustment,
  FocusAdjustmentRecord,
  mayAdjustFocus,
  signedMinutes,
} from '../domain/focus-adjustment';
import {
  FOCUS_ADJUSTMENT_REPOSITORY,
  FocusAdjustmentRepository,
} from '../domain/focus-adjustment.repository';
import { focusAdjustedCopy, NOTICE } from '../domain/notice-copy';
import { PeopleScopeService } from './people-scope.service';
import { FocusAdjustmentView } from './worktime.types';

export interface AdjustFocusInput {
  userId: string;
  date: string;
  minutes: unknown;
  reason: unknown;
}

export interface ListAdjustmentsQuery {
  userId?: string;
  month?: string;
  /** Super Admin or Super Manager with "All organisations" in view: one organisation. */
  companyId?: string;
  includeVoided?: boolean;
  limit?: number;
}

/**
 * Manual focus adjustments (3.3) on 4.0's tenancy. See focus-adjustment.ts for the
 * rules. Writes are the Super Manager's alone, in the organisation she has in view
 * (X-Org-Id) or, with "All organisations", for anyone in a live organisation, and
 * only while the subject's organisation allows them (settings, per organisation).
 * Reading follows the usual scopes: Admin, Super Admin and Super Manager the whole
 * organisation in view, a Manager the Staff of their departments, a person their own.
 */
@Injectable()
export class FocusAdjustmentsService {
  private readonly logger = new Logger(FocusAdjustmentsService.name);

  constructor(
    @Inject(FOCUS_ADJUSTMENT_REPOSITORY) private readonly repo: FocusAdjustmentRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly settings: AppSettingsService,
    private readonly scope: PeopleScopeService,
  ) {}

  /** 403 for anyone but the Super Manager. */
  private assertSuperManager(me: AuthenticatedUser): void {
    if (!mayAdjustFocus(me)) {
      throw new ForbiddenError('Only the Super Manager can adjust focus time.');
    }
  }

  /**
   * The person whose day is adjusted, as the Super Manager may reach them: in the
   * organisation in view when one is picked (404 outside it), else anyone in an
   * organisation. Never a Super Admin, never herself.
   */
  private async subject(me: AuthenticatedUser, userId: string): Promise<ShiftPerson> {
    if (userId === me.id) throw new ForbiddenError('You cannot adjust your own focus time.');
    const org = orgInView(me);
    const target = await this.people.findById(userId);
    const facts = target && {
      id: target.id,
      role: target.role,
      companyId: target.companyId,
      departmentId: target.departmentId,
    };
    const reachable =
      !!target &&
      !!facts &&
      !!target.companyId &&
      target.role !== Role.SUPER_ADMIN &&
      (org ? canSeePerson(me, facts) : true);
    if (!target || !reachable) throw new NotFoundError('User not found');
    return target;
  }

  /** 409 ADJUSTMENTS_OFF when the person's organisation switched them off. */
  private async assertEnabledFor(companyId: string | null): Promise<void> {
    const settings = await this.settings.get(companyId);
    if (!settings.focusAdjustmentsEnabled) {
      throw new ConflictError(
        'Manual focus adjustments are switched off for this organisation. Its admin can turn them on in Settings.',
        'ADJUSTMENTS_OFF',
      );
    }
  }

  /** POST /focus-adjustments */
  async create(
    me: AuthenticatedUser,
    input: AdjustFocusInput,
    now: Date,
  ): Promise<FocusAdjustmentView> {
    this.assertSuperManager(me);
    const target = await this.subject(me, input.userId);
    await this.assertEnabledFor(target.companyId);
    const today = dateKeyInZone(now, appTimezone());
    const check = checkAdjustment({
      minutes: input.minutes,
      reason: input.reason,
      date: input.date,
      today,
      earliest: addDaysToKey(today, -ADJUSTMENT_MAX_AGE_DAYS),
    });
    if (!check.ok) throw new ValidationError(check.message).withDetails({ field: check.field });
    const saved = await this.repo.create(
      {
        userId: target.id,
        date: input.date,
        deltaSec: check.deltaSec,
        reason: check.reason,
        createdById: me.id,
      },
      now,
    );
    this.logger.log(
      `focus of ${target.id} on ${input.date} adjusted ${signedMinutes(check.deltaSec)} by ${me.id}`,
    );
    await this.tell(target.id, saved, me.id);
    return (await this.views([saved]))[0];
  }

  /** DELETE /focus-adjustments/:id: voids it (the trail keeps it). */
  async void(me: AuthenticatedUser, id: string, now: Date): Promise<FocusAdjustmentView> {
    this.assertSuperManager(me);
    const current = await this.repo.findById(id);
    if (!current) throw new NotFoundError('Unknown adjustment');
    // Outside the organisation in view it does not exist for her.
    const target = await this.subject(me, current.userId).catch((err: unknown) => {
      if (err instanceof NotFoundError) throw new NotFoundError('Unknown adjustment');
      throw err;
    });
    if (current.voidedAt) {
      throw new ConflictError('This adjustment was already undone.', 'ALREADY_VOID');
    }
    await this.assertEnabledFor(target.companyId);
    const voided = await this.repo.void(id, me.id, now);
    if (!voided) throw new ConflictError('This adjustment was already undone.', 'ALREADY_VOID');
    await this.tell(target.id, voided, me.id);
    return (await this.views([voided]))[0];
  }

  /**
   * GET /focus-adjustments: Admin, Super Admin and Super Manager see the
   * organisation in view (the two platform roles every organisation with "All
   * organisations", or one with companyId); a Manager the Staff of their departments.
   */
  async list(
    me: AuthenticatedUser,
    q: ListAdjustmentsQuery,
    now: Date,
  ): Promise<FocusAdjustmentView[]> {
    let userIds: string[] | undefined;
    let companyId: string | undefined;
    if (seesEveryOrg(me.role)) {
      companyId = orgInView(me) ?? q.companyId;
    } else if (seesWholeOrg(me)) {
      companyId = requireOrg(me);
    } else {
      this.scope.assertManagerOrAdmin(me);
      const today = dateKeyInZone(now, appTimezone());
      const team = await this.scope.scope(me, { fromDate: '0000-01-01', toDate: today });
      userIds = team.map((p) => p.id);
      if (q.userId && !userIds.includes(q.userId)) return [];
    }
    const rows = await this.repo.list({
      userId: q.userId,
      userIds,
      month: q.month,
      companyId,
      includeVoided: q.includeVoided ?? true,
      limit: q.limit,
    });
    return this.views(rows);
  }

  /** GET /focus-adjustments/me: the person's own live ones, for their dashboard. */
  async mine(me: AuthenticatedUser, month: string | undefined): Promise<FocusAdjustmentView[]> {
    const rows = await this.repo.list({ userId: me.id, month, includeVoided: false, limit: 100 });
    return this.views(rows);
  }

  /** Records as the lists and the day report show them (names resolved in one query). */
  async views(rows: FocusAdjustmentRecord[]): Promise<FocusAdjustmentView[]> {
    if (!rows.length) return [];
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.userId);
      ids.add(r.createdById);
      if (r.voidedById) ids.add(r.voidedById);
    }
    const people = new Map((await this.repo.namesOf([...ids])).map((p) => [p.id, p] as const));
    const nameOf = (id: string | null) => {
      if (!id) return null;
      const p = people.get(id);
      return p ? `${p.firstName} ${p.lastName}`.trim() : 'Former user';
    };
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      userName: nameOf(r.userId) ?? 'Former user',
      companyName: people.get(r.userId)?.companyName ?? null,
      date: r.date,
      deltaSec: r.deltaSec,
      label: signedMinutes(r.deltaSec),
      reason: r.reason,
      createdById: r.createdById,
      createdByName: nameOf(r.createdById) ?? 'Former user',
      createdAt: r.createdAt.toISOString(),
      voidedAt: r.voidedAt?.toISOString() ?? null,
      voidedByName: nameOf(r.voidedById),
    }));
  }

  /** Tells the person (best effort): what changed, by how much and why. */
  private async tell(targetId: string, a: FocusAdjustmentRecord, byId: string): Promise<void> {
    try {
      const copy = focusAdjustedCopy({
        date: a.date,
        deltaSec: a.deltaSec,
        reason: a.reason,
        voided: !!a.voidedAt,
      });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([targetId], NOTICE.FOCUS_ADJUSTED, copy.title, copy.body, byId),
      );
    } catch (err) {
      this.logger.warn(`focus adjustment notice for ${targetId} failed: ${(err as Error).message}`);
    }
  }
}
