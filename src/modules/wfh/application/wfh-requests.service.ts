import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AppException,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { allOrgsInView } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { LeaveDaysService } from '@modules/leave/application/leave-days.service';
import {
  deciderOf,
  fullName,
  LeavePeopleService,
} from '@modules/leave/application/leave-people.service';
import { leaveOn } from '@modules/leave/domain/day-leave';
import {
  daysOf,
  formatDays,
  isStatus,
  kindLabel,
  LeaveStatus,
  maskOf,
  STATUS_LABEL,
} from '@modules/leave/domain/leave.types';
import { partClock } from '@modules/leave/domain/parts';
import {
  checkNote,
  datesOf,
  leaveDay,
  leaveSpan,
  overlapping,
} from '@modules/leave/domain/request-rules';
import { canDecide, routeFor, Route, waitsOn } from '@modules/leave/domain/routing';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { formatDuration } from '@shared/utils/duration';
import {
  checkWfhRequest,
  priceWfhDays,
  scheduleCovers,
  WfhDayInfo,
  WfhDayRecord,
  WfhInput,
  WfhRequestRecord,
  WfhShape,
} from '../domain/wfh';
import {
  CopyWfh,
  WFH_NOTICE,
  wfhCancelledCopy,
  wfhDecidedCopy,
  wfhRequestedCopy,
  wfhRevokedCopy,
} from '../domain/wfh-copy';
import { WfhPolicy } from '../domain/wfh-policy';
import { WFH_REPOSITORY, WfhRepository, WfhTx } from '../domain/wfh.repository';
import { basisSecOf } from './wfh-days.service';
import { WfhPolicyService } from './wfh-policy.service';
import { WfhPreview, WfhRequestView } from './wfh.views';

interface Problem {
  field: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Problems answered 409 (the state of things); the rest are 400 (the request itself). */
const CONFLICT_CODES = new Set([
  'WFH_OFF',
  'WFH_OVERLAP',
  'WFH_SCHEDULED',
  'LEAVE_OVERLAP',
  'WFH_MONTH_CAP',
  'MONTH_LOCKED',
]);

function toError(p: Problem): AppException {
  const details = { field: p.field, ...(p.details ?? {}) };
  return CONFLICT_CODES.has(p.code)
    ? new ConflictError(p.message, p.code).withDetails(details)
    : new ValidationError(p.message, p.code).withDetails(details);
}

function monthsOf(days: readonly { date: string }[], fallback: string): string[] {
  const months = new Set(days.map((d) => d.date.slice(0, 7)));
  if (!months.size) months.add(fallback.slice(0, 7));
  return [...months];
}

/** Published after any change to someone's work from home (realtime refresh). */
export class WfhChangedEvent {
  static readonly eventName = 'wfh.changed';
  constructor(
    public readonly userId: string,
    public readonly startDate: string,
    public readonly endDate: string,
  ) {}
}

export interface WfhListQuery {
  status?: string;
  userId?: string;
  companyId?: string;
  managerId?: string;
  from?: string;
  to?: string;
  needsMe?: boolean;
  limit?: number;
  order?: 'DECIDED';
}

interface Plan {
  shape: WfhShape | null;
  infos: (WfhDayInfo & { shiftStart: string | null; shiftEnd: string | null })[];
  covered: WfhDayRecord[];
  skipped: { date: string; why: string }[];
  units: number;
  route: Route | null;
  problem: Problem | null;
}

/**
 * Work-from-home requests (3.5): ask, preview, cancel, and the approver's approve,
 * reject and revoke. Every change runs under the person's work-from-home lock and
 * checks the payroll month lock. The route is the leave route's rules (4.0): the
 * managers of the person's department by default, the organisation admin when it
 * has none or for a Manager's own request, the Super Admins for an admin's.
 * The policy is the person's organisation's.
 */
@Injectable()
export class WfhRequestsService {
  private readonly logger = new Logger(WfhRequestsService.name);

  constructor(
    @Inject(WFH_REPOSITORY) private readonly repo: WfhRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly policies: WfhPolicyService,
    private readonly people: LeavePeopleService,
    private readonly leaveDays: LeaveDaysService,
    private readonly breakDays: BreakDayService,
  ) {}

  private today(now: Date): string {
    return dateKeyInZone(now, appTimezone());
  }

  private async me(me: AuthenticatedUser): Promise<ShiftPerson> {
    const person = (await this.people.any([me.id])).get(me.id);
    if (!person) throw new NotFoundError('Unknown person');
    return person;
  }

  /** Working days, leave and schedules on these days, for the person. */
  private async infos(person: ShiftPerson, dates: string[], tx: WfhTx): Promise<Plan['infos']> {
    if (!dates.length) return [];
    const [days, leave, schedules] = await Promise.all([
      this.people.dayInfos(person, dates),
      this.leaveDays.byDay([person.id], dates[0], dates[dates.length - 1]),
      tx.schedulesOf(person.id),
    ]);
    return days.map((d) => {
      const l = leaveOn(leave, person.id, d.date);
      const scheduledMask = schedules
        .filter((s) => scheduleCovers(s, d.date))
        .reduce((m, s) => m | maskOf(s.kind, s.part), 0);
      return { ...d, leaveMask: l.mask | l.pendingMask, scheduledMask };
    });
  }

  private async plan(
    person: ShiftPerson,
    input: WfhInput,
    policy: WfhPolicy,
    now: Date,
    tx: WfhTx,
  ): Promise<Plan> {
    const plan: Plan = {
      shape: null,
      infos: [],
      covered: [],
      skipped: [],
      units: 0,
      route: null,
      problem: null,
    };
    if (!policy.enabled) {
      plan.problem = {
        field: 'kind',
        code: 'WFH_OFF',
        message:
          'Work from home requests are switched off. The organisation admin can turn them on.',
      };
      return plan;
    }
    const today = this.today(now);
    const shape = checkWfhRequest(input, { today, policy });
    if (!shape.ok) {
      plan.problem = { field: shape.field, code: shape.code, message: shape.message };
      return plan;
    }
    const s = shape.value;
    plan.shape = s;
    plan.infos = await this.infos(person, datesOf(s.startDate, s.endDate), tx);
    const priced = priceWfhDays(s.kind, s.part, plan.infos);
    plan.covered = priced.covered;
    plan.skipped = priced.skipped;
    plan.units = priced.covered.reduce((n, d) => n + d.units, 0);
    plan.route = routeFor(policy.approver, person, await this.people.routingPeople(person));

    if (!priced.covered.length) {
      const only = plan.infos.length === 1 ? plan.infos[0] : null;
      plan.problem = {
        field: 'startDate',
        code: 'NO_WORKING_DAY',
        message: only
          ? only.workday
            ? `You are on leave on ${leaveDay(only.date)}.`
            : `${leaveDay(only.date)} is not a working day for you (${only.offLabel ?? 'a day off'}).`
          : `There is no working day for you from ${leaveSpan(s.startDate, s.endDate)}.`,
      };
      return plan;
    }

    const scheduled = overlapping(
      priced.covered,
      plan.infos.map((i) => ({ date: i.date, mask: i.scheduledMask })),
    );
    if (scheduled.length) {
      plan.problem = {
        field: 'startDate',
        code: 'WFH_SCHEDULED',
        message: `${scheduled.slice(0, 3).map(leaveDay).join(', ')} ${scheduled.length === 1 ? 'is' : 'are'} already a work-from-home day on your schedule.`,
        details: { dates: scheduled },
      };
      return plan;
    }
    const held = await tx.heldDays(person.id, s.startDate, s.endDate);
    const clash = overlapping(priced.covered, held);
    if (clash.length) {
      const shown = clash.slice(0, 3).map(leaveDay).join(', ');
      plan.problem = {
        field: 'startDate',
        code: 'WFH_OVERLAP',
        message: `You already asked to work from home on ${shown}${clash.length > 3 ? ` and ${clash.length - 3} more` : ''}.`,
        details: { dates: clash },
      };
      return plan;
    }
    const onLeave = overlapping(
      priced.covered,
      plan.infos.map((i) => ({ date: i.date, mask: i.leaveMask })),
    );
    if (onLeave.length) {
      plan.problem = {
        field: 'part',
        code: 'LEAVE_OVERLAP',
        message: `You have leave in that part of ${onLeave.slice(0, 3).map(leaveDay).join(', ')}. Pick the other part of the day.`,
        details: { dates: onLeave },
      };
      return plan;
    }
    if (policy.maxDaysPerMonth !== null) {
      for (const month of monthsOf(priced.covered, s.startDate)) {
        const before = await tx.unitsInMonth(person.id, month);
        const adding = priced.covered
          .filter((d) => d.date.startsWith(`${month}-`))
          .reduce((n, d) => n + d.units, 0);
        if (before + adding > policy.maxDaysPerMonth * 4) {
          plan.problem = {
            field: 'startDate',
            code: 'WFH_MONTH_CAP',
            message:
              `Work from home is at most ${policy.maxDaysPerMonth} days a month: you have ` +
              `${formatDays(before)} in ${monthLabel(month)} already and this adds ${formatDays(adding)}.`,
            details: { month, usedDays: daysOf(before), addingDays: daysOf(adding) },
          };
          return plan;
        }
      }
    }
    for (const month of monthsOf(priced.covered, s.startDate)) {
      try {
        await tx.assertMonthOpen(`${month}-01`, person.id);
      } catch (err) {
        if (err instanceof ConflictError) {
          plan.problem = {
            field: 'startDate',
            code: 'MONTH_LOCKED',
            message: err.message,
            details: { month },
          };
          return plan;
        }
        throw err;
      }
    }
    return plan;
  }

  /** POST /wfh/preview */
  async preview(me: AuthenticatedUser, input: WfhInput, now: Date): Promise<WfhPreview> {
    const person = await this.me(me);
    const policy = await this.policies.get(person.companyId);
    const plan = await this.repo.inUserLock(person.id, (tx) =>
      this.plan(person, input, policy, now, tx),
    );
    const waiting = plan.route?.approverRole
      ? (
          await this.people.waitingFor([
            { approverRole: plan.route.approverRole, userId: person.id },
          ])
        )[0]
      : null;
    const s = plan.shape;
    const covered = new Map(plan.covered.map((d) => [d.date, d] as const));
    const first = plan.infos.find((d) => covered.has(d.date)) ?? plan.infos[0];
    const biometric = person.attendanceSource === 'BIOMETRIC';
    let capPerDaySec: number | null = null;
    if (biometric && first) {
      const ctx = await this.breakDays.context([person.id]);
      capPerDaySec = basisSecOf(
        this.breakDays.resolveWith(ctx, person, first.date).shift,
        policy.creditBasis,
      );
    }
    return {
      ok: !plan.problem,
      problem: plan.problem
        ? { field: plan.problem.field, code: plan.problem.code, message: plan.problem.message }
        : null,
      kind: s?.kind ?? null,
      part: s?.part ?? null,
      startDate: s?.startDate ?? null,
      endDate: s?.endDate ?? null,
      dates: plan.infos.map((d) => {
        const c = covered.get(d.date);
        const skip = plan.skipped.find((x) => x.date === d.date);
        return {
          date: d.date,
          label: leaveDay(d.date),
          covered: !!c,
          days: daysOf(c?.units ?? 0),
          why: skip?.why ?? null,
        };
      }),
      days: daysOf(plan.units),
      daysLabel: formatDays(plan.units),
      partTimes:
        s && s.kind !== 'FULL_DAY' && first
          ? partClock(first.shiftStart, first.shiftEnd, maskOf(s.kind, s.part))
          : null,
      waitingFor: waiting,
      approvedAtOnce: !!plan.route && plan.route.approverRole === null,
      tracking: biometric
        ? 'Start and end each day in the RX Vision phone app' +
          (capPerDaySec ? `; up to ${formatDuration(capPerDaySec)} of a full day counts.` : '.')
        : 'Your desktop app tracks the day as usual.',
      capPerDaySec,
    };
  }

  /** POST /wfh/requests */
  async create(me: AuthenticatedUser, input: WfhInput, now: Date): Promise<WfhRequestView> {
    const person = await this.me(me);
    const policy = await this.policies.get(person.companyId);
    const saved = await this.repo.inUserLock(person.id, async (tx) => {
      const plan = await this.plan(person, input, policy, now, tx);
      if (plan.problem) throw toError(plan.problem);
      const s = plan.shape!;
      const route = plan.route!;
      const atOnce = route.approverRole === null;
      const row = await tx.insertRequest(
        {
          userId: person.id,
          kind: s.kind,
          part: s.part,
          startDate: s.startDate,
          endDate: s.endDate,
          units: plan.units,
          reason: s.reason,
          status: atOnce ? 'APPROVED' : 'PENDING',
          approverRole: route.approverRole,
          approverId: route.approverId,
          decidedById: atOnce ? person.id : null,
          decidedAt: atOnce ? now : null,
        },
        plan.covered,
      );
      return { row, notify: route.notify };
    });
    this.logger.log(
      `wfh ${saved.row.id} of ${person.id}: ${saved.row.startDate}..${saved.row.endDate} ` +
        `${formatDays(saved.row.units)} ${saved.row.status}`,
    );
    if (saved.row.status === 'PENDING' && saved.notify.length) {
      const copy = wfhRequestedCopy({ name: fullName(person), request: copyOf(saved.row) });
      await this.tell(saved.notify, WFH_NOTICE.WFH_REQUESTED, copy.title, copy.body, person.id);
    }
    await this.changed(saved.row);
    return (await this.views(me, [saved.row], now))[0];
  }

  /** POST /wfh/requests/:id/cancel */
  async cancel(me: AuthenticatedUser, id: string, now: Date): Promise<WfhRequestView> {
    const found = await this.repo.findRequest(id);
    if (!found) throw new NotFoundError('Unknown work-from-home request');
    if (found.userId !== me.id) {
      throw new ForbiddenError(
        'You can cancel only your own work from home. An approver can revoke approved work from home.',
      );
    }
    const today = this.today(now);
    const { row, wasApproved } = await this.repo.inUserLock(found.userId, async (tx) => {
      const cur = (await tx.findRequest(id))!;
      if (cur.status !== 'PENDING' && cur.status !== 'APPROVED') {
        throw new ConflictError(
          `This request is already ${STATUS_LABEL[cur.status].toLowerCase()}.`,
          'NOT_CANCELLABLE',
        );
      }
      if (cur.status === 'APPROVED' && cur.startDate < today) {
        throw new ConflictError(
          'This work from home has already begun. Ask your approver to revoke it if it should not count.',
          'WFH_STARTED',
        );
      }
      for (const month of monthsOf(cur.days, cur.startDate))
        await tx.assertMonthOpen(`${month}-01`, cur.userId);
      const updated = await tx.updateRequest(id, { status: 'CANCELLED', cancelledAt: now });
      return { row: updated, wasApproved: cur.status === 'APPROVED' };
    });
    if (wasApproved) {
      const person = await this.me(me);
      const to = new Set<string>();
      if (row.decidedById && row.decidedById !== me.id) to.add(row.decidedById);
      if (person.managerId && person.managerId !== me.id) to.add(person.managerId);
      if (to.size) {
        const copy = wfhCancelledCopy({ name: fullName(person), request: copyOf(row) });
        await this.tell([...to], WFH_NOTICE.WFH_CANCELLED, copy.title, copy.body, me.id);
      }
    }
    await this.changed(row);
    return (await this.views(me, [row], now))[0];
  }

  private async decidable(
    me: AuthenticatedUser,
    id: string,
  ): Promise<{ req: WfhRequestRecord; target: ShiftPerson }> {
    const req = await this.repo.findRequest(id);
    if (!req) throw new NotFoundError('Unknown work-from-home request');
    const target = (await this.people.any([req.userId])).get(req.userId);
    if (!target) throw new NotFoundError('Unknown person');
    if (req.userId === me.id)
      throw new ForbiddenError('You cannot decide your own work from home.');
    // 4.0: outside the caller's organisation or departments it does not exist for them.
    if (!this.people.canSee(me, target)) throw new NotFoundError('Unknown work-from-home request');
    if (!canDecide(deciderOf(me), req, target)) {
      throw new ForbiddenError(
        me.role === Role.MANAGER
          ? "Only a manager of this person's department can decide it (its route or the department changed)."
          : 'This request is waiting for someone else to decide.',
      );
    }
    return { req, target };
  }

  /** POST /wfh/requests/:id/approve and /reject */
  async decide(
    me: AuthenticatedUser,
    id: string,
    approve: boolean,
    note: unknown,
    now: Date,
  ): Promise<WfhRequestView> {
    const { target } = await this.decidable(me, id);
    const checked = checkNote(note, !approve);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'note' });
    const row = await this.repo.inUserLock(target.id, async (tx) => {
      const cur = (await tx.findRequest(id))!;
      if (cur.status !== 'PENDING') {
        throw new ConflictError(
          `This request is already ${STATUS_LABEL[cur.status].toLowerCase()}.`,
          'ALREADY_DECIDED',
        );
      }
      for (const month of monthsOf(cur.days, cur.startDate))
        await tx.assertMonthOpen(`${month}-01`, cur.userId);
      if (!approve) {
        return tx.updateRequest(id, {
          status: 'REJECTED',
          decidedById: me.id,
          decidedAt: now,
          decisionNote: checked.note,
        });
      }
      // Days that became days off or leave since the request are left out.
      const infos = await this.infos(
        target,
        cur.days.map((d) => d.date),
        tx,
      );
      const kept = cur.days.filter((d) => {
        const i = infos.find((x) => x.date === d.date);
        return i && i.workday && (i.leaveMask & d.mask) === 0;
      });
      if (!kept.length) {
        return tx.updateRequest(id, {
          status: 'CANCELLED',
          cancelledAt: now,
          decisionNote:
            'Every day of this request is now a day off or on leave, so nothing is left to approve.',
        });
      }
      return tx.updateRequest(
        id,
        {
          status: 'APPROVED',
          decidedById: me.id,
          decidedAt: now,
          decisionNote: checked.note,
          units: kept.reduce((n, d) => n + d.units, 0),
        },
        kept.length !== cur.days.length ? kept : undefined,
      );
    });
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    const copy = wfhDecidedCopy({
      request: copyOf(row),
      approved: row.status === 'APPROVED',
      byName,
      note: row.status === 'CANCELLED' ? row.decisionNote : checked.note,
    });
    await this.tell([target.id], WFH_NOTICE.WFH_DECIDED, copy.title, copy.body, me.id);
    this.logger.log(`wfh ${id} of ${target.id} ${row.status} by ${me.id}`);
    await this.changed(row);
    return (await this.views(me, [row], now))[0];
  }

  /** POST /wfh/requests/:id/revoke */
  async revoke(
    me: AuthenticatedUser,
    id: string,
    note: unknown,
    now: Date,
  ): Promise<WfhRequestView> {
    const { target } = await this.decidable(me, id);
    const checked = checkNote(note, true);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'note' });
    const row = await this.repo.inUserLock(target.id, async (tx) => {
      const cur = (await tx.findRequest(id))!;
      if (cur.status !== 'APPROVED') {
        throw new ConflictError(
          cur.status === 'PENDING'
            ? 'This request is still waiting: reject it instead.'
            : `This request is already ${STATUS_LABEL[cur.status].toLowerCase()}.`,
          'NOT_APPROVED',
        );
      }
      for (const month of monthsOf(cur.days, cur.startDate))
        await tx.assertMonthOpen(`${month}-01`, cur.userId);
      return tx.updateRequest(id, {
        status: 'REVOKED',
        decidedById: me.id,
        decidedAt: now,
        decisionNote: checked.note,
      });
    });
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    const copy = wfhRevokedCopy({ request: copyOf(row), byName, note: checked.note! });
    await this.tell([target.id], WFH_NOTICE.WFH_REVOKED, copy.title, copy.body, me.id);
    this.logger.log(`wfh ${id} of ${target.id} revoked by ${me.id}`);
    await this.changed(row);
    return (await this.views(me, [row], now))[0];
  }

  /** GET /wfh/requests/:id */
  async get(me: AuthenticatedUser, id: string, now: Date): Promise<WfhRequestView> {
    const row = await this.repo.findRequest(id);
    if (!row) throw new NotFoundError('Unknown work-from-home request');
    if (row.userId !== me.id) await this.people.visible(me, row.userId);
    return (await this.views(me, [row], now))[0];
  }

  /** The person's own requests, newest first. */
  async mine(me: AuthenticatedUser, now: Date): Promise<WfhRequestView[]> {
    const rows = await this.repo.listRequests({ userId: me.id, limit: 300 });
    return this.views(me, rows, now);
  }

  /** GET /wfh/requests: the requests in the caller's scope, pending first. */
  async list(
    me: AuthenticatedUser,
    q: WfhListQuery,
    now: Date,
  ): Promise<{ items: WfhRequestView[]; summary: { pending: number; needsMe: number } }> {
    const scope = await this.people.scopeIds(me, {
      companyId: allOrgsInView(me) ? q.companyId : undefined,
      managerId: q.managerId,
    });
    const statuses = (q.status ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(isStatus) as LeaveStatus[];
    if (q.userId && scope && !scope.includes(q.userId)) {
      throw new ForbiddenError('That person is not in your team.');
    }
    const rows = await this.repo.listRequests({
      userId: q.userId,
      userIds: scope,
      statuses: statuses.length ? statuses : undefined,
      from: q.from,
      to: q.to,
      limit: q.limit ?? 300,
      order: q.order ?? (q.from || q.to ? 'SOONEST' : 'NEWEST'),
    });
    const views = await this.views(me, rows, now);
    const waiting = await this.waitingOnMe(me, rows);
    const items = q.needsMe ? views.filter((v) => waiting.has(v.id)) : views;
    items.sort((a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING'));
    return { items, summary: await this.summary(me, { companyId: q.companyId }) };
  }

  /** GET /wfh/requests/summary: the badge. */
  async summary(
    me: AuthenticatedUser,
    q: { companyId?: string } = {},
  ): Promise<{ pending: number; needsMe: number }> {
    const scope = await this.people.scopeIds(me, {
      companyId: allOrgsInView(me) ? q.companyId : undefined,
    });
    const pending = await this.repo.listRequests({
      userIds: scope,
      statuses: ['PENDING'],
      limit: 1000,
    });
    const waiting = await this.waitingOnMe(me, pending);
    return { pending: pending.length, needsMe: waiting.size };
  }

  private async waitingOnMe(me: AuthenticatedUser, rows: WfhRequestRecord[]): Promise<Set<string>> {
    const pending = rows.filter((r) => r.status === 'PENDING');
    if (!pending.length) return new Set();
    const targets = await this.people.any(pending.map((r) => r.userId));
    const withManager = await this.people.departmentsWithManager(
      [...targets.values()].map((t) => t.departmentId),
    );
    const decider = deciderOf(me);
    const out = new Set<string>();
    for (const r of pending) {
      const t = targets.get(r.userId);
      if (!t || !this.people.canSee(me, t)) continue;
      const target = {
        role: t.role,
        departmentId: t.departmentId,
        departmentHasManager: !!t.departmentId && withManager.has(t.departmentId),
      };
      if (waitsOn(decider, r, target)) out.add(r.id);
    }
    return out;
  }

  async views(
    me: AuthenticatedUser,
    rows: WfhRequestRecord[],
    now: Date,
  ): Promise<WfhRequestView[]> {
    if (!rows.length) return [];
    const today = this.today(now);
    const people = await this.people.any(rows.flatMap((r) => [r.userId, r.decidedById ?? '']));
    const waiting = await this.people.waitingFor(
      rows.map((r) => ({
        approverRole: r.status === 'PENDING' ? r.approverRole : null,
        userId: r.userId,
      })),
    );
    const parts = rows.filter((r) => r.kind !== 'FULL_DAY' && people.get(r.userId));
    const times = await this.people.shiftTimes(
      parts.map((r) => ({ person: people.get(r.userId)!, date: r.startDate })),
    );
    // Taking back is refused in a locked month (revoke), so it is not offered there.
    // 4.0: months lock per organisation, the person's own (as revoke checks it).
    const approved = rows.filter((r) => r.status === 'APPROVED');
    const locked = await this.repo.lockedMonths(
      approved.map((r) => people.get(r.userId)?.companyId ?? ''),
      approved.flatMap((r) => monthsOf(r.days, r.startDate)),
    );
    const inLockedMonth = (r: WfhRequestRecord) => {
      const org = people.get(r.userId)?.companyId;
      return !!org && monthsOf(r.days, r.startDate).some((m) => locked.has(`${org}|${m}`));
    };
    return rows.map((r, i) => {
      const person = people.get(r.userId);
      const decide =
        !!person &&
        this.people.canSee(me, person) &&
        canDecide(deciderOf(me), r, { role: person.role, departmentId: person.departmentId });
      const t = times.get(`${r.userId}:${r.startDate}`);
      return {
        id: r.id,
        userId: r.userId,
        userName: fullName(person),
        avatarId: person?.avatarId ?? null,
        department: person?.department ?? null,
        companyId: person?.companyId ?? null,
        companyName: person?.companyName ?? null,
        attendanceSource: person?.attendanceSource === 'BIOMETRIC' ? 'BIOMETRIC' : 'AGENT',
        kind: r.kind,
        part: r.part,
        kindLabel: kindLabel(r.kind, r.part),
        startDate: r.startDate,
        endDate: r.endDate,
        span: leaveSpan(r.startDate, r.endDate),
        days: daysOf(r.units),
        daysLabel: formatDays(r.units),
        dates: r.days.map((d) => ({
          date: d.date,
          label: leaveDay(d.date),
          days: daysOf(d.units),
        })),
        partTimes: t ? partClock(t.start, t.end, maskOf(r.kind, r.part)) : null,
        reason: r.reason,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status],
        approverRole: r.approverRole,
        waitingFor: waiting[i],
        decidedById: r.decidedById,
        decidedByName: r.decidedById ? fullName(people.get(r.decidedById)) : null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        cancelledAt: r.cancelledAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        can: {
          cancel:
            r.userId === me.id &&
            (r.status === 'PENDING' || (r.status === 'APPROVED' && r.startDate >= today)),
          decide: r.status === 'PENDING' && decide,
          revoke: r.status === 'APPROVED' && decide && !inLockedMonth(r),
        },
      };
    });
  }

  private async changed(r: { userId: string; startDate: string; endDate: string }): Promise<void> {
    await this.events
      .publish(WfhChangedEvent.eventName, new WfhChangedEvent(r.userId, r.startDate, r.endDate))
      .catch(() => undefined);
  }

  private async tell(
    to: string[],
    type: string,
    title: string,
    body: string,
    fromUserId: string | null,
  ) {
    try {
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(to, type, title, body, fromUserId),
      );
    } catch (err) {
      this.logger.warn(`wfh notice ${type} failed: ${(err as Error).message}`);
    }
  }
}

export function copyOf(r: WfhRequestRecord): CopyWfh {
  return {
    startDate: r.startDate,
    endDate: r.endDate,
    units: r.units,
    kind: r.kind,
    part: r.part,
    reason: r.reason,
  };
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}
