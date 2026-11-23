import { Inject, Injectable, Logger } from '@nestjs/common';
import { API_COPY } from '@shared/copy/api-copy';
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
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { spendableUnits } from '../domain/balance';
import { allocateCompOff, compOffBalanceOf, lotsOf } from '../domain/comp-off';
import {
  leaveCancelledCopy,
  leaveDecidedCopy,
  LEAVE_NOTICE,
  leaveRequestedCopy,
  leaveRevokedCopy,
  leaveUpdatedCopy,
  CopyRequest,
} from '../domain/leave-copy';
import {
  LEAVE_REPOSITORY,
  LeaveDayRecord,
  LeaveRepository,
  LeaveRequestRecord,
  LeaveTx,
} from '../domain/leave.repository';
import {
  alreadyStatus,
  CATEGORY_LABEL,
  daysOf,
  formatDays,
  isCategory,
  isStatus,
  kindLabel,
  LeaveCategory,
  LeaveStatus,
  maskOf,
  STATUS_LABEL,
} from '../domain/leave.types';
import { partClock } from '../domain/parts';
import {
  checkNote,
  checkRequest,
  datesOf,
  leaveDay,
  leaveSpan,
  overlapping,
  priceDays,
  RequestInput,
  RequestShape,
} from '../domain/request-rules';
import { canDecide, routeFor, Route, waitsOn } from '../domain/routing';
import { deciderOf } from './leave-people.service';
import { LeaveAccountsService } from './leave-accounts.service';
import { DayWithShift, fullName, LeavePeopleService } from './leave-people.service';
import { LeavePolicyService, LivePolicy } from './leave-policy.service';
import { LeavePreview, LeaveRequestView } from './leave.views';

/** Something that stops a request, as the preview shows it and create throws it. */
interface Problem {
  field: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Problems answered 409 (the state of things); the rest are 400 (the request itself). */
const CONFLICT_CODES = new Set([
  'LEAVE_OFF',
  'LEAVE_OVERLAP',
  'NOT_ENOUGH_LEAVE',
  'MONTH_LOCKED',
  'COMPOFF_OFF',
  'NOT_ENOUGH_COMPOFF',
]);

function toError(p: Problem): AppException {
  const details = { field: p.field, ...(p.details ?? {}) };
  return CONFLICT_CODES.has(p.code)
    ? new ConflictError(p.message, p.code).withDetails(details)
    : new ValidationError(p.message, p.code).withDetails(details);
}

/** Every month a request's days touch. */
function monthsOf(days: readonly { date: string }[], fallback: string): string[] {
  const months = new Set(days.map((d) => d.date.slice(0, 7)));
  if (!months.size) months.add(fallback.slice(0, 7));
  return [...months];
}

/** Published after any change to someone's leave (realtime refresh, caches). */
export class LeaveChangedEvent {
  static readonly eventName = 'leave.changed';
  constructor(
    public readonly userId: string,
    public readonly startDate: string,
    public readonly endDate: string,
  ) {}
}

export interface ListQuery {
  status?: string;
  userId?: string;
  companyId?: string;
  managerId?: string;
  from?: string;
  to?: string;
  category?: string;
  needsMe?: boolean;
  limit?: number;
  order?: 'DECIDED';
}

interface Plan {
  shape: RequestShape | null;
  days: DayWithShift[];
  charged: LeaveDayRecord[];
  skipped: { date: string; why: string }[];
  units: number;
  route: Route | null;
  balance: { category: LeaveCategory; beforeUnits: number } | null;
  problem: Problem | null;
}

/**
 * Leave requests (3.4): apply, preview, cancel, and the approver's approve, reject
 * and revoke. Every change runs under the person's leave lock, so two requests can
 * never spend the same days, and checks the payroll month lock.
 */
@Injectable()
export class LeaveRequestsService {
  private readonly logger = new Logger(LeaveRequestsService.name);

  constructor(
    @Inject(LEAVE_REPOSITORY) private readonly repo: LeaveRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly policies: LeavePolicyService,
    private readonly accounts: LeaveAccountsService,
    private readonly people: LeavePeopleService,
  ) {}

  private today(now: Date): string {
    return dateKeyInZone(now, appTimezone());
  }

  private async me(me: AuthenticatedUser): Promise<ShiftPerson> {
    const person = (await this.people.any([me.id])).get(me.id);
    if (!person) throw new NotFoundError('Unknown person');
    return person;
  }

  /**
   * Works a request out without saving it: the days it charges, the balance before
   * and after, who decides it, and the first thing that stops it. With `tx`, the
   * checks that need the person's lock run in it.
   */
  private async plan(
    person: ShiftPerson,
    input: RequestInput,
    policy: LivePolicy,
    now: Date,
    tx: LeaveTx,
  ): Promise<Plan> {
    const plan: Plan = {
      shape: null,
      days: [],
      charged: [],
      skipped: [],
      units: 0,
      route: null,
      balance: null,
      problem: null,
    };
    const today = this.today(now);
    if (!policy.enabled) {
      plan.problem = {
        field: 'category',
        code: 'LEAVE_OFF',
        message:
          'Leave requests are switched off. A Super Admin or the Super Manager can turn them on.',
      };
      return plan;
    }
    const joinDate = await this.people.joinDate(person.id);
    const shape = checkRequest(input, { today, policy, joinDate });
    if (!shape.ok) {
      plan.problem = { field: shape.field, code: shape.code, message: shape.message };
      return plan;
    }
    const s = shape.value;
    plan.shape = s;
    if (s.category === 'COMPOFF' && !policy.compOffEnabled) {
      plan.problem = {
        field: 'category',
        code: 'COMPOFF_OFF',
        message: 'Comp off is switched off. A Super Admin or the Super Manager can turn it on.',
      };
      return plan;
    }
    plan.days = await this.people.dayInfos(person, datesOf(s.startDate, s.endDate));
    const priced = priceDays(s.kind, s.part, plan.days);
    plan.charged = priced.charged;
    plan.skipped = priced.skipped;
    plan.units = priced.charged.reduce((n, d) => n + d.units, 0);
    plan.route = routeFor(policy.approver, person, await this.people.routingPeople(person));

    if (!priced.charged.length) {
      const only = plan.days.length === 1 ? plan.days[0] : null;
      plan.problem = {
        field: 'startDate',
        code: 'NO_WORKING_DAY',
        message: only
          ? `${leaveDay(only.date)} is not a working day for you (${only.offLabel ?? 'a day off'}).`
          : `There is no working day for you from ${leaveSpan(s.startDate, s.endDate)}.`,
      };
      return plan;
    }

    const held = await tx.heldDays(person.id, s.startDate, s.endDate);
    const clash = overlapping(priced.charged, held);
    if (clash.length) {
      const shown = clash.slice(0, 3).map(leaveDay).join(', ');
      plan.problem = {
        field: 'startDate',
        code: 'LEAVE_OVERLAP',
        message: `You already have leave on ${shown}${clash.length > 3 ? ` and ${clash.length - 3} more` : ''}.`,
        details: { dates: clash },
      };
      return plan;
    }

    if (s.category === 'COMPOFF') {
      const check = await this.compOffCheck(tx, person.id, today, {
        requestId: 'new',
        days: priced.charged,
        status: 'PENDING',
      });
      plan.balance = { category: 'COMPOFF', beforeUnits: check.availableUnits };
      if (!check.fits) {
        const covered = Math.max(0, plan.units - check.shortUnits);
        plan.problem = {
          field: 'category',
          code: 'NOT_ENOUGH_COMPOFF',
          message:
            check.availableUnits <= 0
              ? 'You have no comp off to take. Claim an extra day you worked first.'
              : `Not enough comp off valid on ${leaveSpan(s.startDate, s.endDate)}: your credits cover ` +
                `${formatDays(covered)} of the ${formatDays(plan.units)} this needs.`,
          details: { availableDays: daysOf(check.availableUnits), neededDays: daysOf(plan.units) },
        };
        return plan;
      }
      return this.checkMonths(plan, priced.charged, s.startDate, person.id, tx);
    }

    const thisYear = Number(today.slice(0, 4));
    const { balances } = await this.accounts.balancesIn(
      tx,
      person.id,
      Math.max(thisYear, s.year),
      policy,
      joinDate,
    );
    const b = balances[s.category].get(s.year);
    if (!b) {
      plan.problem = {
        field: 'startDate',
        code: 'NO_LEAVE_YEAR',
        message: `You have no leave in ${s.year}.`,
      };
      return plan;
    }
    const spendable = spendableUnits(b, s.year <= thisYear);
    plan.balance = { category: s.category, beforeUnits: spendable };
    if (plan.units > spendable) {
      const pending =
        b.pendingUnits > 0 ? ` (${formatDays(b.pendingUnits)} waiting for approval)` : '';
      plan.problem = {
        field: 'category',
        code: 'NOT_ENOUGH_LEAVE',
        message:
          `Not enough ${CATEGORY_LABEL[s.category]}: you have ${formatDays(Math.max(0, spendable))} ` +
          `left${pending} and this needs ${formatDays(plan.units)}.`,
        details: { availableDays: daysOf(spendable), neededDays: daysOf(plan.units) },
      };
      return plan;
    }
    return this.checkMonths(plan, priced.charged, s.startDate, person.id, tx);
  }

  /** The last check of a plan: none of its days is in a month locked for payroll. */
  private async checkMonths(
    plan: Plan,
    charged: LeaveDayRecord[],
    startDate: string,
    userId: string,
    tx: LeaveTx,
  ): Promise<Plan> {
    for (const month of monthsOf(charged, startDate)) {
      try {
        await tx.assertMonthOpen(`${month}-01`, userId);
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

  /**
   * Comp off available from today, and whether `extra` days fit on the credits as
   * well (3.5). `exceptRequestId`: leave that request's own days out first.
   */
  private async compOffCheck(
    tx: LeaveTx,
    userId: string,
    today: string,
    extra: { requestId: string; days: LeaveDayRecord[]; status: 'PENDING' | 'APPROVED' } | null,
    exceptRequestId?: string,
  ): Promise<{
    availableUnits: number;
    availableAfter: number;
    fits: boolean;
    shortUnits: number;
  }> {
    const [credits, uses] = await Promise.all([
      tx.credits(userId),
      tx.compOffUses(userId, exceptRequestId),
    ]);
    const lots = lotsOf(credits);
    const base = allocateCompOff(lots, uses, today);
    const availableUnits = compOffBalanceOf(base, credits).availableUnits;
    if (!extra)
      return { availableUnits, availableAfter: availableUnits, fits: true, shortUnits: 0 };
    const more = extra.days.map((d) => ({
      requestId: extra.requestId,
      date: d.date,
      units: d.units,
      status: extra.status,
      order: Number.MAX_SAFE_INTEGER,
    }));
    const after = allocateCompOff(lots, [...uses, ...more], today);
    const shortUnits = Math.max(0, after.shortUnits - base.shortUnits);
    return {
      availableUnits,
      availableAfter: compOffBalanceOf(after, credits).availableUnits,
      fits: shortUnits === 0,
      shortUnits,
    };
  }

  /** What is left of the request's leave type once it has been decided (for the notice). */
  private async availableAfter(
    tx: LeaveTx,
    userId: string,
    row: LeaveRequestRecord,
    policy: LivePolicy,
    joinDate: string,
    now: Date,
  ): Promise<number> {
    if (row.category === 'COMPOFF') {
      return (await this.compOffCheck(tx, userId, this.today(now), null)).availableUnits;
    }
    const thisYear = Number(this.today(now).slice(0, 4));
    const { balances } = await this.accounts.balancesIn(
      tx,
      userId,
      Math.max(thisYear, row.year),
      policy,
      joinDate,
    );
    return balances[row.category].get(row.year)?.availableUnits ?? 0;
  }

  /** POST /leave/preview: what a request would do, without making it. */
  async preview(me: AuthenticatedUser, input: RequestInput, now: Date): Promise<LeavePreview> {
    const person = await this.me(me);
    const policy = await this.policies.get(person.companyId, now);
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
    const chargedDates = new Map(plan.charged.map((d) => [d.date, d] as const));
    const first = plan.days.find((d) => d.workday) ?? plan.days[0];
    return {
      ok: !plan.problem,
      problem: plan.problem
        ? { field: plan.problem.field, code: plan.problem.code, message: plan.problem.message }
        : null,
      category: s?.category ?? (isCategory(input.category) ? input.category : null),
      kind: s?.kind ?? null,
      part: s?.part ?? null,
      startDate: s?.startDate ?? null,
      endDate: s?.endDate ?? null,
      year: s?.year ?? null,
      dates: plan.days.map((d) => ({
        date: d.date,
        label: leaveDay(d.date),
        charged: chargedDates.has(d.date),
        days: daysOf(chargedDates.get(d.date)?.units ?? 0),
        why: d.workday ? null : d.offLabel,
      })),
      days: daysOf(plan.units),
      daysLabel: formatDays(plan.units),
      partTimes:
        s && s.kind !== 'FULL_DAY' && first
          ? partClock(first.shiftStart, first.shiftEnd, maskOf(s.kind, s.part))
          : null,
      balance: plan.balance
        ? {
            category: plan.balance.category,
            label: CATEGORY_LABEL[plan.balance.category],
            beforeDays: daysOf(plan.balance.beforeUnits),
            afterDays: daysOf(plan.balance.beforeUnits - plan.units),
          }
        : null,
      waitingFor: waiting,
      approvedAtOnce: !!plan.route && plan.route.approverRole === null,
    };
  }

  /** POST /leave/requests: the person applies for their own leave. */
  async create(me: AuthenticatedUser, input: RequestInput, now: Date): Promise<LeaveRequestView> {
    const person = await this.me(me);
    const policy = await this.policies.get(person.companyId, now);
    const saved = await this.repo.inUserLock(person.id, async (tx) => {
      const plan = await this.plan(person, input, policy, now, tx);
      if (plan.problem) throw toError(plan.problem);
      const s = plan.shape!;
      const route = plan.route!;
      const atOnce = route.approverRole === null;
      const row = await tx.insertRequest(
        {
          userId: person.id,
          category: s.category,
          kind: s.kind,
          part: s.part,
          startDate: s.startDate,
          endDate: s.endDate,
          year: s.year,
          units: plan.units,
          reason: s.reason,
          status: atOnce ? 'APPROVED' : 'PENDING',
          approverRole: route.approverRole,
          approverId: route.approverId,
          decidedById: atOnce ? person.id : null,
          decidedAt: atOnce ? now : null,
        },
        plan.charged,
      );
      return { row, notify: route.notify };
    });
    this.logger.log(
      `leave ${saved.row.id} of ${person.id}: ${saved.row.category} ${saved.row.startDate}..${saved.row.endDate} ` +
        `${formatDays(saved.row.units)} ${saved.row.status}`,
    );
    if (saved.row.status === 'PENDING' && saved.notify.length) {
      const copy = leaveRequestedCopy({ name: fullName(person), request: this.copyOf(saved.row) });
      await this.tell(saved.notify, LEAVE_NOTICE.LEAVE_REQUESTED, copy.title, copy.body, person.id);
    }
    await this.changed(saved.row);
    return (await this.views(me, [saved.row], now))[0];
  }

  /** POST /leave/requests/:id/cancel: the person takes back a pending request, or approved leave not yet begun. */
  async cancel(me: AuthenticatedUser, id: string, now: Date): Promise<LeaveRequestView> {
    const found = await this.repo.findRequest(id);
    if (!found) throw new NotFoundError(API_COPY.leaveRequestNotFound);
    if (found.userId !== me.id) {
      throw new ForbiddenError(
        'You can cancel only your own leave. An approver can revoke approved leave.',
      );
    }
    const today = this.today(now);
    const { row, wasApproved } = await this.repo.inUserLock(found.userId, async (tx) => {
      const cur = (await tx.findRequest(id))!;
      if (cur.status !== 'PENDING' && cur.status !== 'APPROVED') {
        throw new ConflictError(`This request ${alreadyStatus(cur.status)}.`, 'NOT_CANCELLABLE');
      }
      if (cur.status === 'APPROVED' && cur.startDate < today) {
        throw new ConflictError(API_COPY.leaveStarted, 'LEAVE_STARTED');
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
        const copy = leaveCancelledCopy({ name: fullName(person), request: this.copyOf(row) });
        await this.tell([...to], LEAVE_NOTICE.LEAVE_CANCELLED, copy.title, copy.body, me.id);
      }
    }
    await this.changed(row);
    return (await this.views(me, [row], now))[0];
  }

  private async decidable(
    me: AuthenticatedUser,
    id: string,
  ): Promise<{ req: LeaveRequestRecord; target: ShiftPerson }> {
    const req = await this.repo.findRequest(id);
    if (!req) throw new NotFoundError(API_COPY.leaveRequestNotFound);
    const target = (await this.people.any([req.userId])).get(req.userId);
    if (!target) throw new NotFoundError('Unknown person');
    if (req.userId === me.id) throw new ForbiddenError('You cannot decide your own leave.');
    // 4.0: outside the caller's organisation or departments it does not exist for them.
    if (!this.people.canSee(me, target)) throw new NotFoundError(API_COPY.leaveRequestNotFound);
    if (!canDecide(deciderOf(me), req, target)) {
      throw new ForbiddenError(
        me.role === Role.MANAGER
          ? "Only a manager of this person's department can decide it (its route or the department changed)."
          : 'This request is waiting for someone else to decide.',
      );
    }
    return { req, target };
  }

  /** POST /leave/requests/:id/approve and /reject. */
  async decide(
    me: AuthenticatedUser,
    id: string,
    approve: boolean,
    note: unknown,
    now: Date,
  ): Promise<LeaveRequestView> {
    const { target } = await this.decidable(me, id);
    const checked = checkNote(note, !approve);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'note' });
    const policy = await this.policies.get(target.companyId, now);
    const joinDate = await this.people.joinDate(target.id);
    const thisYear = Number(this.today(now).slice(0, 4));
    const outcome = await this.repo.inUserLock(target.id, async (tx) => {
      const cur = (await tx.findRequest(id))!;
      if (cur.status !== 'PENDING') {
        throw new ConflictError(`This request ${alreadyStatus(cur.status)}.`, 'ALREADY_DECIDED');
      }
      for (const month of monthsOf(cur.days, cur.startDate))
        await tx.assertMonthOpen(`${month}-01`, cur.userId);
      if (!approve) {
        const row = await tx.updateRequest(id, {
          status: 'REJECTED',
          decidedById: me.id,
          decidedAt: now,
          decisionNote: checked.note,
        });
        return {
          row,
          givenBack: [] as { date: string; why: string }[],
          available: await this.availableAfter(tx, target.id, row, policy, joinDate, now),
        };
      }
      // Days that have become days off since the request are not charged.
      const infos = await this.people.dayInfos(
        target,
        cur.days.map((d) => d.date),
      );
      const kept = cur.days.filter((d) => infos.find((i) => i.date === d.date)?.workday);
      const givenBack = infos
        .filter((i) => !i.workday)
        .map((i) => ({ date: i.date, why: i.offLabel ?? 'Day off' }));
      if (!kept.length) {
        const row = await tx.updateRequest(id, {
          status: 'CANCELLED',
          cancelledAt: now,
          decisionNote: 'Every day of this leave is now a day off, so nothing is charged.',
        });
        return { row, givenBack, available: 0, closed: true };
      }
      const units = kept.reduce((n, d) => n + d.units, 0);
      if (cur.category === 'COMPOFF') {
        const check = await this.compOffCheck(
          tx,
          target.id,
          this.today(now),
          { requestId: cur.id, days: kept, status: 'APPROVED' },
          cur.id,
        );
        if (!check.fits) {
          throw new ConflictError(
            `${fullName(target)}'s comp off credits valid on those days cover ` +
              `${formatDays(Math.max(0, units - check.shortUnits))} of the ${formatDays(units)} this needs. ` +
              'Reject it, or credit comp off first.',
            'NOT_ENOUGH_COMPOFF',
          ).withDetails({ availableDays: daysOf(check.availableUnits), neededDays: daysOf(units) });
        }
        const row = await tx.updateRequest(
          id,
          {
            status: 'APPROVED',
            decidedById: me.id,
            decidedAt: now,
            decisionNote: checked.note,
            units,
          },
          kept.length !== cur.days.length ? kept : undefined,
        );
        return { row, givenBack, available: check.availableAfter };
      }
      const { balances } = await this.accounts.balancesIn(
        tx,
        target.id,
        Math.max(thisYear, cur.year),
        policy,
        joinDate,
      );
      const b = balances[cur.category].get(cur.year)!;
      // Its own reservation is in the pending figure: give it back before checking.
      const spendable = spendableUnits(b, cur.year <= thisYear) + cur.units;
      if (units > spendable) {
        throw new ConflictError(
          `${fullName(target)} has ${formatDays(Math.max(0, spendable))} of ${CATEGORY_LABEL[cur.category]} left ` +
            `and this needs ${formatDays(units)}. Reject it, or add days to the balance first.`,
          'NOT_ENOUGH_LEAVE',
        ).withDetails({ availableDays: daysOf(spendable), neededDays: daysOf(units) });
      }
      const row = await tx.updateRequest(
        id,
        {
          status: 'APPROVED',
          decidedById: me.id,
          decidedAt: now,
          decisionNote: checked.note,
          units,
        },
        kept.length !== cur.days.length ? kept : undefined,
      );
      return { row, givenBack, available: spendable - units };
    });
    const row = outcome.row;
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    if (row.status === 'CANCELLED') {
      const copy = leaveUpdatedCopy({
        request: this.copyOf(row),
        givenBack: outcome.givenBack,
        cancelled: true,
      });
      await this.tell([target.id], LEAVE_NOTICE.LEAVE_UPDATED, copy.title, copy.body, me.id);
    } else {
      const copy = leaveDecidedCopy({
        request: this.copyOf(row),
        approved: approve,
        byName,
        note: checked.note,
        availableUnits: outcome.available,
      });
      await this.tell([target.id], LEAVE_NOTICE.LEAVE_DECIDED, copy.title, copy.body, me.id);
    }
    this.logger.log(`leave ${id} of ${target.id} ${row.status} by ${me.id}`);
    await this.changed(row);
    return (await this.views(me, [row], now))[0];
  }

  /** POST /leave/requests/:id/revoke: an approver takes back approved leave, with a note. */
  async revoke(
    me: AuthenticatedUser,
    id: string,
    note: unknown,
    now: Date,
  ): Promise<LeaveRequestView> {
    const { target } = await this.decidable(me, id);
    const checked = checkNote(note, true);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'note' });
    const policy = await this.policies.get(target.companyId, now);
    const joinDate = await this.people.joinDate(target.id);
    const { row, available } = await this.repo.inUserLock(target.id, async (tx) => {
      const cur = (await tx.findRequest(id))!;
      if (cur.status !== 'APPROVED') {
        throw new ConflictError(
          cur.status === 'PENDING'
            ? 'This request is still waiting: reject it instead.'
            : `This request ${alreadyStatus(cur.status)}.`,
          'NOT_APPROVED',
        );
      }
      for (const month of monthsOf(cur.days, cur.startDate))
        await tx.assertMonthOpen(`${month}-01`, cur.userId);
      const updated = await tx.updateRequest(id, {
        status: 'REVOKED',
        decidedById: me.id,
        decidedAt: now,
        decisionNote: checked.note,
      });
      return {
        row: updated,
        available: await this.availableAfter(tx, target.id, updated, policy, joinDate, now),
      };
    });
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    const copy = leaveRevokedCopy({
      request: this.copyOf(row),
      byName,
      note: checked.note!,
      availableUnits: available,
    });
    await this.tell([target.id], LEAVE_NOTICE.LEAVE_REVOKED, copy.title, copy.body, me.id);
    this.logger.log(`leave ${id} of ${target.id} revoked by ${me.id}`);
    await this.changed(row);
    return (await this.views(me, [row], now))[0];
  }

  /** GET /leave/requests/:id: the person's own, or one in the caller's scope. */
  async get(me: AuthenticatedUser, id: string, now: Date): Promise<LeaveRequestView> {
    const row = await this.repo.findRequest(id);
    if (!row) throw new NotFoundError(API_COPY.leaveRequestNotFound);
    if (row.userId !== me.id) await this.people.visible(me, row.userId);
    return (await this.views(me, [row], now))[0];
  }

  /** The person's own requests (one year, or this year and the next). */
  async mine(me: AuthenticatedUser, years: number[], now: Date): Promise<LeaveRequestView[]> {
    const rows = (
      await Promise.all(
        years.map((year) => this.repo.listRequests({ userId: me.id, year, limit: 300 })),
      )
    ).flat();
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return this.views(me, rows, now);
  }

  /** GET /leave/requests: the requests in the caller's scope, with what waits on them. */
  async list(
    me: AuthenticatedUser,
    q: ListQuery,
    now: Date,
  ): Promise<{ items: LeaveRequestView[]; summary: { pending: number; needsMe: number } }> {
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
      category: isCategory(q.category) ? q.category : undefined,
      limit: q.limit ?? 300,
      order: q.order ?? (q.from || q.to ? 'SOONEST' : 'NEWEST'),
    });
    const views = await this.views(me, rows, now);
    const waiting = await this.waitingOnMe(me, rows);
    const items = q.needsMe ? views.filter((v) => waiting.has(v.id)) : views;
    const summary = await this.summary(me, { companyId: q.companyId });
    // Pending first, then the order asked for.
    items.sort((a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING'));
    return { items, summary };
  }

  /** GET /leave/requests/summary: the badge. */
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

  private async waitingOnMe(
    me: AuthenticatedUser,
    rows: LeaveRequestRecord[],
  ): Promise<Set<string>> {
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

  /** Requests as the caller sees them, names and "what you may do" included. */
  async views(
    me: AuthenticatedUser,
    rows: LeaveRequestRecord[],
    now: Date,
  ): Promise<LeaveRequestView[]> {
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
    const inLockedMonth = (r: LeaveRequestRecord) => {
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
        category: r.category,
        categoryLabel: CATEGORY_LABEL[r.category],
        kind: r.kind,
        part: r.part,
        kindLabel: kindLabel(r.kind, r.part),
        startDate: r.startDate,
        endDate: r.endDate,
        span: leaveSpan(r.startDate, r.endDate),
        year: r.year,
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

  copyOf(r: LeaveRequestRecord): CopyRequest {
    return {
      category: r.category,
      startDate: r.startDate,
      endDate: r.endDate,
      units: r.units,
      kindLabel: kindLabel(r.kind, r.part),
      reason: r.reason,
    };
  }

  private async changed(r: LeaveRequestRecord): Promise<void> {
    await this.events.publish(
      LeaveChangedEvent.eventName,
      new LeaveChangedEvent(r.userId, r.startDate, r.endDate),
    );
  }

  private async tell(
    to: string[],
    type: string,
    title: string,
    body: string,
    fromUserId: string | null,
  ): Promise<void> {
    try {
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(to, type, title, body, fromUserId),
      );
    } catch (err) {
      this.logger.warn(`leave notice ${type} failed: ${(err as Error).message}`);
    }
  }
}
