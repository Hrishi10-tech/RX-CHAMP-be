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
import { Role } from '@shared/rbac/roles.enum';
import { allOrgsInView } from '@shared/tenancy';
import {
  addDaysToKey,
  appTimezone,
  dateKeyInZone,
  isoWeekdayOfKey,
  isValidDateKey,
} from '@shared/utils/timezone';
import { formatDuration } from '@shared/utils/duration';
import { LeaveDaysService } from '@modules/leave/application/leave-days.service';
import {
  deciderOf,
  fullName,
  LeavePeopleService,
} from '@modules/leave/application/leave-people.service';
import { LeavePolicyService, LivePolicy } from '@modules/leave/application/leave-policy.service';
import { dayLeaveView, leaveOn } from '@modules/leave/domain/day-leave';
import {
  allocateCompOff,
  COMPOFF_DAY_KIND_LABEL,
  CompOffAllocation,
  compOffBalanceOf,
  CompOffCreditRecord,
  CompOffDayKind,
  earnedUnits,
  expiryOf,
  lotsOf,
  secondsNeeded,
} from '@modules/leave/domain/comp-off';
import { LEAVE_REPOSITORY, LeaveRepository } from '@modules/leave/domain/leave.repository';
import {
  alreadyStatus,
  daysOf,
  formatDays,
  isStatus,
  LeaveStatus,
  STATUS_LABEL,
} from '@modules/leave/domain/leave.types';
import {
  checkNote,
  datesOf,
  leaveDay,
  REASON_MAX,
  REASON_MIN,
} from '@modules/leave/domain/request-rules';
import { canDecide, routeFor, waitsOn } from '@modules/leave/domain/routing';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { DayDataService } from '@modules/worktime/application/day-data.service';
import { expectedSecOf } from '@modules/worktime/domain/attendance';
import { focusOfDay } from '@modules/worktime/domain/day';
import {
  claimedCopy,
  COMPOFF_NOTICE,
  creditedCopy,
  decidedCopy,
  expiringCopy,
  revokedCopy,
} from '../domain/compoff-copy';

const WEEKDAY_NAME = [
  '',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
/** Who approves, credits and revokes comp off (4.0: department managers, the organisation admin, above). */
const OVERSEER_ROLES: string[] = [Role.MANAGER, Role.ADMIN, Role.SUPER_MANAGER, Role.SUPER_ADMIN];

/** A credit is announced this many days before it lapses. */
export const EXPIRY_NOTICE_DAYS = 7;
/** A credit by hand can be for a day up to this far back. */
const GRANT_BACK_DAYS = 365;

/** Published after any change to someone's comp off (realtime refresh). */
export class CompOffChangedEvent {
  static readonly eventName = 'compoff.changed';
  constructor(public readonly userId: string) {}
}

export interface ExtraDayView {
  date: string;
  label: string;
  kind: CompOffDayKind;
  /** "Sunday", "Diwali", "On leave (CL/SL)" */
  dayLabel: string;
  workedSec: number;
  workedLabel: string;
  /** Days it earns now (0, 0.5 or 1) and what each needs. */
  earnsDays: number;
  halfDayNeedsSec: number;
  fullDayNeedsSec: number;
  /** Already claimed or credited (waiting or approved). */
  claimed: boolean;
  claimId: string | null;
  /** Can be claimed now, and why not when it cannot. */
  claimable: boolean;
  why: string | null;
}

export interface CreditView {
  id: string;
  userId: string;
  userName: string;
  /** The person's effective avatar (3.6). */
  avatarId: string | null;
  department: string | null;
  companyName: string | null;
  workedDate: string;
  workedLabel: string;
  dayKind: CompOffDayKind;
  dayLabel: string;
  workedSec: number;
  workedTime: string;
  askedDays: number;
  days: number;
  daysLabel: string;
  reason: string;
  source: 'CLAIM' | 'GRANT';
  status: LeaveStatus;
  statusLabel: string;
  waitingFor: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  expiresOn: string | null;
  expiresLabel: string | null;
  /** Approved credits: what drew on it, and what is left (or lapsed). */
  usedDays: number;
  heldDays: number;
  leftDays: number;
  lapsedDays: number;
  createdAt: string;
  can: { cancel: boolean; decide: boolean; revoke: boolean };
}

function sentence(text: unknown, field: string, what: string): string {
  const t = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  if (t.length < REASON_MIN || t.length > REASON_MAX) {
    throw new ValidationError(
      `Give ${what}, ${REASON_MIN} to ${REASON_MAX} characters.`,
    ).withDetails({ field });
  }
  return t;
}

function unitsOf(days: unknown, field: string): 2 | 4 {
  if (days === 1 || days === '1' || days === 'FULL_DAY') return 4;
  if (days === 0.5 || days === '0.5' || days === 'HALF_DAY') return 2;
  throw new ValidationError('Comp off is a full day (1) or a half day (0.5).').withDetails({
    field,
  });
}

/**
 * Comp off (3.5): extra days worked (a weekly off, a holiday, a full day of leave),
 * claims approved on their route, credits by hand, and the views. Taking comp off is
 * a leave request of type COMPOFF (the leave module charges it against credits).
 * Every change runs under the person's leave lock. 4.0: the rules are the person's
 * organisation's leave policy; claims route like leave (the department's managers,
 * else the organisation admin); a day off set on the organisation calendar is a
 * holiday, another day off a weekly one.
 */
@Injectable()
export class CompOffService {
  private readonly logger = new Logger(CompOffService.name);

  constructor(
    @Inject(LEAVE_REPOSITORY) private readonly repo: LeaveRepository,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly people: LeavePeopleService,
    private readonly policies: LeavePolicyService,
    private readonly dayData: DayDataService,
    private readonly days: BreakDayService,
    private readonly leaveDays: LeaveDaysService,
  ) {}

  private today(now: Date): string {
    return dateKeyInZone(now, appTimezone());
  }

  private assertOn(policy: LivePolicy): void {
    if (!policy.compOffEnabled) {
      throw new ConflictError(
        'Comp off is switched off. The organisation admin can turn it on.',
        'COMPOFF_OFF',
      );
    }
  }

  // ---- Extra days ---------------------------------------------------------------------

  /** A person's extra days from `from` to `to` (inclusive), with what each earns. */
  async extraDays(
    person: ShiftPerson,
    from: string,
    to: string,
    policy: LivePolicy,
    now: Date,
    credits?: CompOffCreditRecord[],
  ): Promise<ExtraDayView[]> {
    if (from > to) return [];
    const [data, ctx, leave, mine, infos] = await Promise.all([
      this.dayData.load([person.id], from, to, now),
      this.days.context([person.id]),
      this.leaveDays.byDay([person.id], from, to),
      credits ? Promise.resolve(credits) : this.repo.creditsOf([person.id]),
      this.people.dayInfos(person, datesOf(from, to)),
    ]);
    const infoOf = new Map(infos.map((i) => [i.date, i] as const));
    const today = this.today(now);
    const windowStart = addDaysToKey(today, -policy.compOffClaimWithinDays);
    const out: ExtraDayView[] = [];
    for (let d = from; d <= to; d = addDaysToKey(d, 1)) {
      const info = infoOf.get(d);
      const shift = this.days.resolveWith(ctx, person, d).shift;
      const l = leaveOn(leave, person.id, d);
      let kind: CompOffDayKind | null = null;
      let dayLabel = '';
      if (info && !info.workday) {
        kind = info.holiday ? 'HOLIDAY' : 'WEEKLY_OFF';
        dayLabel = info.holiday ?? WEEKDAY_NAME[isoWeekdayOfKey(d)];
      } else if (l.full && policy.compOffCountLeaveDays) {
        kind = 'LEAVE';
        dayLabel = `On leave (${dayLeaveView(l)?.categories || 'leave'})`;
      }
      if (!kind) continue;
      const pd = data.day(person.id, d);
      if (!pd.sessions.length) continue;
      const running = pd.sessions.some((s) => s.endedAt === null);
      const focus = focusOfDay(pd, now);
      const basis = expectedSecOf(shift);
      const earns = running
        ? 0
        : earnedUnits(focus.focusSec, basis, policy.compOffFullDayPct, policy.compOffHalfDayPct);
      const claim = mine.find(
        (c) => c.workedDate === d && (c.status === 'PENDING' || c.status === 'APPROVED'),
      );
      const halfNeeds = secondsNeeded(2, basis, policy.compOffFullDayPct, policy.compOffHalfDayPct);
      let why: string | null = null;
      if (claim) why = claim.status === 'PENDING' ? 'Claimed, waiting for approval' : 'Credited';
      else if (running) why = 'The day is still running: claim it once it has ended.';
      else if (d < windowStart)
        why = `Claims are made within ${policy.compOffClaimWithinDays} days of the day worked.`;
      else if (!earns) why = `A half day needs ${formatDuration(halfNeeds)} of focus time.`;
      out.push({
        date: d,
        label: leaveDay(d),
        kind,
        dayLabel,
        workedSec: focus.focusSec,
        workedLabel: formatDuration(focus.focusSec),
        earnsDays: earns / 4,
        halfDayNeedsSec: halfNeeds,
        fullDayNeedsSec: secondsNeeded(
          4,
          basis,
          policy.compOffFullDayPct,
          policy.compOffHalfDayPct,
        ),
        claimed: !!claim,
        claimId: claim?.id ?? null,
        claimable: !why && !!earns,
        why,
      });
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  // ---- My comp off ----------------------------------------------------------------------

  /** GET /leave/comp-off/me */
  async my(me: AuthenticatedUser, now: Date) {
    const person = await this.person(me.id);
    const policy = await this.policies.get(person.companyId, now);
    const today = this.today(now);
    const credits = await this.repo.creditsOf([me.id]);
    const uses = (await this.repo.compOffUsesOf([me.id])).get(me.id) ?? [];
    const alloc = allocateCompOff(lotsOf(credits), uses, today);
    const extra = await this.extraDays(
      person,
      addDaysToKey(today, -Math.max(policy.compOffClaimWithinDays, 31)),
      today,
      policy,
      now,
      credits,
    );
    const route = routeFor(policy.compOffApprover, person, await this.people.routingPeople(person));
    const waitingFor = route.approverRole
      ? (await this.people.waitingFor([{ approverRole: route.approverRole, userId: me.id }]))[0]
      : null;
    const b = compOffBalanceOf(alloc, credits);
    return {
      enabled: policy.compOffEnabled,
      today,
      rules: {
        validityDays: policy.compOffValidityDays,
        claimWithinDays: policy.compOffClaimWithinDays,
        fullDayPct: policy.compOffFullDayPct,
        halfDayPct: policy.compOffHalfDayPct,
        countLeaveDays: policy.compOffCountLeaveDays,
        maxBalanceDays: policy.compOffMaxBalanceDays,
        rule:
          `A weekly day off, a holiday${policy.compOffCountLeaveDays ? ' or a day of leave' : ''} worked earns comp off: ` +
          `a full day at ${policy.compOffFullDayPct}% of your shift's expected time, a half day at ${policy.compOffHalfDayPct}%. ` +
          `Claim it within ${policy.compOffClaimWithinDays} days; take it within ${policy.compOffValidityDays} days of the day worked.`,
      },
      balance: {
        availableDays: daysOf(b.availableUnits),
        pendingDays: daysOf(b.pendingUnits),
        takenDays: daysOf(b.takenUnits),
        earnedDays: daysOf(b.earnedUnits),
        lapsedDays: daysOf(b.lapsedUnits),
        claimsWaitingDays: daysOf(b.claimsWaitingUnits),
        nextExpiry: b.nextExpiry
          ? {
              date: b.nextExpiry.date,
              label: leaveDay(b.nextExpiry.date),
              days: daysOf(b.nextExpiry.units),
            }
          : null,
      },
      waitingFor,
      extraDays: extra,
      credits: await this.views(me, credits.slice().reverse(), now, new Map([[me.id, alloc]])),
    };
  }

  /** POST /leave/comp-off/claims */
  async claim(
    me: AuthenticatedUser,
    dto: { date: unknown; days?: unknown; reason: unknown },
    now: Date,
  ) {
    const person = await this.person(me.id);
    const policy = await this.policies.get(person.companyId, now);
    this.assertOn(policy);
    if (typeof dto.date !== 'string' || !isValidDateKey(dto.date)) {
      throw new ValidationError('Pick the day you worked (YYYY-MM-DD).').withDetails({
        field: 'date',
      });
    }
    const date = dto.date;
    const reason = sentence(dto.reason, 'reason', 'what you worked on');
    const [day] = (await this.extraDays(person, date, date, policy, now)).filter(
      (d) => d.date === date,
    );
    if (!day) {
      throw new ConflictError(
        `${leaveDay(date)} was a working day for you, or you did not work it: only extra days earn comp off.`,
        'NOT_AN_EXTRA_DAY',
      ).withDetails({ field: 'date' });
    }
    if (!day.claimable) {
      throw new ConflictError(
        day.why ?? 'This day cannot be claimed.',
        day.claimed ? 'ALREADY_CLAIMED' : 'NOT_CLAIMABLE',
      ).withDetails({
        field: 'date',
      });
    }
    const asked =
      dto.days === undefined || dto.days === null ? day.earnsDays * 4 : unitsOf(dto.days, 'days');
    if (asked > day.earnsDays * 4) {
      throw new ConflictError(
        `You worked ${day.workedLabel} on ${day.label}: a full day needs ${formatDuration(day.fullDayNeedsSec)}. Claim a half day.`,
        'NOT_ENOUGH_WORKED',
      ).withDetails({ field: 'days' });
    }
    const route = routeFor(policy.compOffApprover, person, await this.people.routingPeople(person));
    const atOnce = route.approverRole === null;
    const saved = await this.repo.inUserLock(person.id, async (tx) => {
      const mine = await tx.credits(person.id);
      if (
        mine.some(
          (c) => c.workedDate === date && (c.status === 'PENDING' || c.status === 'APPROVED'),
        )
      ) {
        throw new ConflictError(`${leaveDay(date)} is already claimed.`, 'ALREADY_CLAIMED');
      }
      if (atOnce) await this.assertUnderCap(tx, person.id, asked, policy, now);
      return tx.insertCredit({
        userId: person.id,
        workedDate: date,
        dayKind: day.kind,
        dayLabel: day.dayLabel,
        workedSec: day.workedSec,
        askedUnits: asked,
        units: atOnce ? asked : 0,
        reason,
        source: 'CLAIM',
        status: atOnce ? 'APPROVED' : 'PENDING',
        approverRole: route.approverRole,
        approverId: route.approverId,
        decidedById: atOnce ? person.id : null,
        decidedAt: atOnce ? now : null,
        decisionNote: null,
        expiresOn: atOnce ? expiryOf(date, policy.compOffValidityDays) : null,
        createdById: person.id,
      });
    });
    this.logger.log(
      `comp off claim ${saved.id} of ${person.id} for ${date}: ${formatDays(asked)} ${saved.status}`,
    );
    if (saved.status === 'PENDING' && route.notify.length) {
      const copy = claimedCopy({
        name: fullName(person),
        workedDate: date,
        dayLabel: day.dayLabel,
        workedLabel: day.workedLabel,
        units: asked,
        reason,
      });
      await this.tell(route.notify, COMPOFF_NOTICE.COMPOFF_CLAIMED, copy, person.id);
    }
    await this.changed(person.id);
    return (await this.views(me, [saved], now))[0];
  }

  /** POST /leave/comp-off/claims/:id/cancel: the person takes back a claim still waiting. */
  async cancel(me: AuthenticatedUser, id: string, now: Date) {
    const found = await this.repo.findCredit(id);
    if (!found) throw new NotFoundError('Unknown comp off claim');
    if (found.userId !== me.id) throw new ForbiddenError('You can cancel only your own claim.');
    const saved = await this.repo.inUserLock(found.userId, async (tx) => {
      const cur = (await tx.findCredit(id))!;
      if (cur.status !== 'PENDING') {
        throw new ConflictError(`This claim ${alreadyStatus(cur.status)}.`, 'NOT_CANCELLABLE');
      }
      return tx.updateCredit(id, { status: 'CANCELLED', cancelledAt: now });
    });
    await this.changed(saved.userId);
    return (await this.views(me, [saved], now))[0];
  }

  private async decidable(me: AuthenticatedUser, id: string, opts: { revoke?: boolean } = {}) {
    const c = await this.repo.findCredit(id);
    if (!c) throw new NotFoundError('Unknown comp off claim');
    const target = (await this.people.any([c.userId])).get(c.userId);
    if (!target) throw new NotFoundError('Unknown person');
    if (c.userId === me.id) throw new ForbiddenError('You cannot decide your own comp off.');
    // 4.0: outside the caller's organisation or departments it does not exist for them.
    if (!this.people.canSee(me, target)) throw new NotFoundError('Unknown comp off claim');
    // Whoever approved or credited it may also take it back.
    const own = opts.revoke && c.decidedById === me.id && OVERSEER_ROLES.includes(me.role);
    if (!own && !canDecide(deciderOf(me), c, target)) {
      throw new ForbiddenError(
        me.role === Role.MANAGER
          ? "Only a manager of this person's department can decide it (its route or the department changed)."
          : 'This claim is waiting for someone else to decide.',
      );
    }
    return { credit: c, target };
  }

  /** No new credit beyond the cap (when one is set). */
  private async assertUnderCap(
    tx: Parameters<Parameters<LeaveRepository['inUserLock']>[1]>[0],
    userId: string,
    units: number,
    policy: LivePolicy,
    now: Date,
  ): Promise<void> {
    if (policy.compOffMaxBalanceDays === null) return;
    const [credits, uses] = await Promise.all([tx.credits(userId), tx.compOffUses(userId)]);
    const b = compOffBalanceOf(allocateCompOff(lotsOf(credits), uses, this.today(now)), credits);
    const cap = Math.round(policy.compOffMaxBalanceDays * 4);
    if (b.availableUnits + b.pendingUnits + units > cap) {
      throw new ConflictError(
        `Comp off is capped at ${formatDays(cap)}: ${formatDays(b.availableUnits + b.pendingUnits)} is held already.`,
        'COMPOFF_CAP',
      ).withDetails({ capDays: daysOf(cap) });
    }
  }

  /** POST /leave/comp-off/claims/:id/approve and /reject */
  async decide(
    me: AuthenticatedUser,
    id: string,
    approve: boolean,
    dto: { days?: unknown; note?: unknown },
    now: Date,
  ) {
    const { target } = await this.decidable(me, id);
    const checked = checkNote(dto.note, !approve);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'note' });
    const policy = await this.policies.get(target.companyId, now);
    const saved = await this.repo.inUserLock(target.id, async (tx) => {
      const cur = (await tx.findCredit(id))!;
      if (cur.status !== 'PENDING') {
        throw new ConflictError(`This claim ${alreadyStatus(cur.status)}.`, 'ALREADY_DECIDED');
      }
      if (!approve) {
        return tx.updateCredit(id, {
          status: 'REJECTED',
          decidedById: me.id,
          decidedAt: now,
          decisionNote: checked.note,
        });
      }
      const units =
        dto.days === undefined || dto.days === null ? cur.askedUnits : unitsOf(dto.days, 'days');
      if (units > cur.askedUnits) {
        throw new ValidationError(
          `The claim asks for ${formatDays(cur.askedUnits)}: approve that, or a half day.`,
        ).withDetails({ field: 'days' });
      }
      await this.assertUnderCap(tx, target.id, units, policy, now);
      return tx.updateCredit(id, {
        status: 'APPROVED',
        units,
        decidedById: me.id,
        decidedAt: now,
        decisionNote: checked.note,
        expiresOn: expiryOf(cur.workedDate, policy.compOffValidityDays),
      });
    });
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    const copy = decidedCopy({
      workedDate: saved.workedDate,
      approved: approve,
      byName,
      askedUnits: saved.askedUnits,
      units: saved.units,
      expiresOn: saved.expiresOn,
      note: checked.note,
    });
    await this.tell([target.id], COMPOFF_NOTICE.COMPOFF_DECIDED, copy, me.id);
    this.logger.log(`comp off ${id} of ${target.id} ${saved.status} by ${me.id}`);
    await this.changed(target.id);
    return (await this.views(me, [saved], now))[0];
  }

  /** POST /leave/comp-off/claims/:id/revoke: take back an approved credit nothing needs. */
  async revoke(me: AuthenticatedUser, id: string, note: unknown, now: Date) {
    const { target } = await this.decidable(me, id, { revoke: true });
    const checked = checkNote(note, true);
    if (!checked.ok) throw new ValidationError(checked.message).withDetails({ field: 'note' });
    const saved = await this.repo.inUserLock(target.id, async (tx) => {
      const cur = (await tx.findCredit(id))!;
      if (cur.status !== 'APPROVED') {
        throw new ConflictError(
          cur.status === 'PENDING'
            ? 'This claim is still waiting: reject it instead.'
            : `This claim ${alreadyStatus(cur.status)}.`,
          'NOT_APPROVED',
        );
      }
      const [credits, uses] = await Promise.all([tx.credits(target.id), tx.compOffUses(target.id)]);
      const today = this.today(now);
      const before = allocateCompOff(lotsOf(credits), uses, today);
      const after = allocateCompOff(lotsOf(credits.filter((c) => c.id !== id)), uses, today);
      if (after.shortUnits > before.shortUnits) {
        const days = [...new Set(before.draws.filter((d) => d.creditId === id).map((d) => d.date))];
        throw new ConflictError(
          `Comp off leave on ${days.slice(0, 3).map(leaveDay).join(', ')} needs this credit. Revoke or reject that leave first.`,
          'COMPOFF_IN_USE',
        ).withDetails({ dates: days });
      }
      return tx.updateCredit(id, {
        status: 'REVOKED',
        decidedById: me.id,
        decidedAt: now,
        decisionNote: checked.note,
      });
    });
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    await this.tell(
      [target.id],
      COMPOFF_NOTICE.COMPOFF_CREDITED,
      revokedCopy({
        workedDate: saved.workedDate,
        byName,
        units: saved.units,
        note: checked.note!,
      }),
      me.id,
    );
    await this.changed(target.id);
    return (await this.views(me, [saved], now))[0];
  }

  /** POST /leave/comp-off/grants: comp off credited by hand (work that was not tracked). */
  async grant(
    me: AuthenticatedUser,
    dto: { userId: string; date: unknown; days: unknown; reason: unknown },
    now: Date,
  ) {
    if (!OVERSEER_ROLES.includes(me.role)) {
      throw new ForbiddenError('Only managers can credit comp off.');
    }
    const target = await this.person(dto.userId);
    if (target.id === me.id) throw new ForbiddenError('You cannot credit comp off to yourself.');
    // 4.0: a Manager the Staff of their departments; admins their organisation.
    if (!this.people.canSee(me, target)) throw new NotFoundError('Unknown person');
    const policy = await this.policies.get(target.companyId, now);
    this.assertOn(policy);
    const today = this.today(now);
    if (typeof dto.date !== 'string' || !isValidDateKey(dto.date) || dto.date > today) {
      throw new ValidationError('Pick the day worked: today or a day before.').withDetails({
        field: 'date',
      });
    }
    const date = dto.date;
    if (date < addDaysToKey(today, -GRANT_BACK_DAYS)) {
      throw new ValidationError(
        `Comp off can be credited for days up to ${GRANT_BACK_DAYS} days back.`,
      ).withDetails({ field: 'date' });
    }
    const units = unitsOf(dto.days, 'days');
    const reason = sentence(dto.reason, 'reason', 'a reason the person will read');
    const expiresOn = expiryOf(date, policy.compOffValidityDays);
    if (expiresOn < today) {
      throw new ConflictError(
        `Comp off for ${leaveDay(date)} would have lapsed on ${leaveDay(expiresOn)} (valid ${policy.compOffValidityDays} days).`,
        'WOULD_HAVE_LAPSED',
      ).withDetails({ field: 'date' });
    }
    const [info] = await this.people.dayInfos(target, [date]);
    const leave = leaveOn(await this.leaveDays.byDay([target.id], date, date), target.id, date);
    const kind: CompOffDayKind = !info.workday
      ? info.holiday
        ? 'HOLIDAY'
        : 'WEEKLY_OFF'
      : leave.full
        ? 'LEAVE'
        : 'WORKING';
    const dayLabel =
      kind === 'HOLIDAY'
        ? (info.holiday ?? 'Holiday')
        : kind === 'WEEKLY_OFF'
          ? WEEKDAY_NAME[isoWeekdayOfKey(date)]
          : COMPOFF_DAY_KIND_LABEL[kind];
    const data = await this.dayData.load([target.id], date, date, now);
    const workedSec = focusOfDay(data.day(target.id, date), now).focusSec;
    const saved = await this.repo.inUserLock(target.id, async (tx) => {
      const mine = await tx.credits(target.id);
      if (
        mine.some(
          (c) => c.workedDate === date && (c.status === 'PENDING' || c.status === 'APPROVED'),
        )
      ) {
        throw new ConflictError(
          `${fullName(target)} already has comp off claimed or credited for ${leaveDay(date)}.`,
          'ALREADY_CLAIMED',
        );
      }
      await this.assertUnderCap(tx, target.id, units, policy, now);
      return tx.insertCredit({
        userId: target.id,
        workedDate: date,
        dayKind: kind,
        dayLabel,
        workedSec,
        askedUnits: units,
        units,
        reason,
        source: 'GRANT',
        status: 'APPROVED',
        approverRole: null,
        approverId: null,
        decidedById: me.id,
        decidedAt: now,
        decisionNote: null,
        expiresOn,
        createdById: me.id,
      });
    });
    const byName = fullName((await this.people.any([me.id])).get(me.id));
    await this.tell(
      [target.id],
      COMPOFF_NOTICE.COMPOFF_CREDITED,
      creditedCopy({ workedDate: date, byName, units, expiresOn, reason }),
      me.id,
    );
    this.logger.log(
      `comp off credited by hand to ${target.id} for ${date}: ${formatDays(units)} by ${me.id}`,
    );
    await this.changed(target.id);
    return (await this.views(me, [saved], now))[0];
  }

  // ---- Approvers ----------------------------------------------------------------------

  /** GET /leave/comp-off/claims: claims and credits in scope, waiting first. */
  async list(
    me: AuthenticatedUser,
    q: {
      status?: string;
      userId?: string;
      companyId?: string;
      needsMe?: boolean;
      limit?: number;
      order?: 'DECIDED';
    },
    now: Date,
  ) {
    const scope = await this.people.scopeIds(me, {
      companyId: allOrgsInView(me) ? q.companyId : undefined,
    });
    if (q.userId && scope && !scope.includes(q.userId))
      throw new ForbiddenError('That person is not in your team.');
    const statuses = (q.status ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(isStatus) as LeaveStatus[];
    const rows = await this.repo.listCredits({
      userId: q.userId,
      userIds: scope,
      statuses: statuses.length ? statuses : undefined,
      limit: q.limit ?? 300,
      order: q.order,
    });
    const waiting = await this.waitingOnMe(me, rows);
    const items = await this.views(
      me,
      q.needsMe ? rows.filter((r) => waiting.has(r.id)) : rows,
      now,
    );
    items.sort((a, b) => Number(b.status === 'PENDING') - Number(a.status === 'PENDING'));
    return { items, summary: await this.summary(me, { companyId: q.companyId }) };
  }

  /** GET /leave/comp-off/claims/summary: the badge. */
  async summary(me: AuthenticatedUser, q: { companyId?: string } = {}) {
    const scope = await this.people.scopeIds(me, {
      companyId: allOrgsInView(me) ? q.companyId : undefined,
    });
    const pending = await this.repo.listCredits({
      userIds: scope,
      statuses: ['PENDING'],
      limit: 1000,
    });
    return { pending: pending.length, needsMe: (await this.waitingOnMe(me, pending)).size };
  }

  /** GET /leave/comp-off/people/:userId: one person's comp off (themselves or in scope). */
  async personView(me: AuthenticatedUser, userId: string, now: Date) {
    const target = await this.people.visible(me, userId);
    const policy = await this.policies.get(target.companyId, now);
    const today = this.today(now);
    const credits = await this.repo.creditsOf([target.id]);
    const uses = (await this.repo.compOffUsesOf([target.id])).get(target.id) ?? [];
    const alloc = allocateCompOff(lotsOf(credits), uses, today);
    const b = compOffBalanceOf(alloc, credits);
    return {
      userId: target.id,
      userName: fullName(target),
      avatarId: target.avatarId ?? null,
      balance: {
        availableDays: daysOf(b.availableUnits),
        pendingDays: daysOf(b.pendingUnits),
        takenDays: daysOf(b.takenUnits),
        earnedDays: daysOf(b.earnedUnits),
        lapsedDays: daysOf(b.lapsedUnits),
        claimsWaitingDays: daysOf(b.claimsWaitingUnits),
      },
      extraDays: await this.extraDays(
        target,
        addDaysToKey(today, -Math.max(policy.compOffClaimWithinDays, 31)),
        today,
        policy,
        now,
        credits,
      ),
      credits: await this.views(me, credits.slice().reverse(), now, new Map([[target.id, alloc]])),
      canGrant:
        OVERSEER_ROLES.includes(me.role) && target.id !== me.id && this.people.canSee(me, target),
    };
  }

  private async waitingOnMe(
    me: AuthenticatedUser,
    rows: CompOffCreditRecord[],
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

  async views(
    me: AuthenticatedUser,
    rows: CompOffCreditRecord[],
    now: Date,
    allocations?: Map<string, CompOffAllocation>,
  ): Promise<CreditView[]> {
    if (!rows.length) return [];
    const today = this.today(now);
    const people = await this.people.any(rows.flatMap((r) => [r.userId, r.decidedById ?? '']));
    const allocs = allocations ?? new Map<string, CompOffAllocation>();
    const missing = [...new Set(rows.map((r) => r.userId))].filter((id) => !allocs.has(id));
    if (missing.length) {
      const [credits, uses] = await Promise.all([
        this.repo.creditsOf(missing),
        this.repo.compOffUsesOf(missing),
      ]);
      for (const id of missing) {
        allocs.set(
          id,
          allocateCompOff(
            lotsOf(credits.filter((c) => c.userId === id)),
            uses.get(id) ?? [],
            today,
          ),
        );
      }
    }
    const waiting = await this.people.waitingFor(
      rows.map((r) => ({
        approverRole: r.status === 'PENDING' ? r.approverRole : null,
        userId: r.userId,
      })),
    );
    return rows.map((r, i) => {
      const person = people.get(r.userId);
      const lot = allocs.get(r.userId)?.lots.find((l) => l.id === r.id);
      const sees = !!person && this.people.canSee(me, person);
      const decide =
        sees &&
        canDecide(deciderOf(me), r, { role: person!.role, departmentId: person!.departmentId });
      const mayRevoke =
        decide ||
        (sees && r.decidedById === me.id && OVERSEER_ROLES.includes(me.role) && r.userId !== me.id);
      return {
        id: r.id,
        userId: r.userId,
        userName: fullName(person),
        avatarId: person?.avatarId ?? null,
        department: person?.department ?? null,
        companyName: person?.companyName ?? null,
        workedDate: r.workedDate,
        workedLabel: leaveDay(r.workedDate),
        dayKind: r.dayKind,
        dayLabel: r.dayLabel || COMPOFF_DAY_KIND_LABEL[r.dayKind],
        workedSec: r.workedSec,
        workedTime: formatDuration(r.workedSec),
        askedDays: daysOf(r.askedUnits),
        days: daysOf(r.status === 'APPROVED' || r.status === 'REVOKED' ? r.units : r.askedUnits),
        daysLabel: formatDays(
          r.status === 'APPROVED' || r.status === 'REVOKED' ? r.units : r.askedUnits,
        ),
        reason: r.reason,
        source: r.source,
        status: r.status,
        statusLabel:
          r.source === 'GRANT' && r.status === 'APPROVED' ? 'Credited' : STATUS_LABEL[r.status],
        waitingFor: waiting[i],
        decidedByName: r.decidedById ? fullName(people.get(r.decidedById)) : null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        expiresOn: r.expiresOn,
        expiresLabel: r.expiresOn ? leaveDay(r.expiresOn) : null,
        usedDays: daysOf(lot?.usedUnits ?? 0),
        heldDays: daysOf(lot?.heldUnits ?? 0),
        leftDays: daysOf(lot?.remainingUnits ?? 0),
        lapsedDays: daysOf(lot?.lapsedUnits ?? 0),
        createdAt: r.createdAt.toISOString(),
        can: {
          cancel: r.userId === me.id && r.status === 'PENDING',
          decide: r.status === 'PENDING' && decide,
          revoke:
            r.status === 'APPROVED' &&
            mayRevoke &&
            (lot?.usedUnits ?? 0) + (lot?.heldUnits ?? 0) === 0,
        },
      };
    });
  }

  // ---- The daily job --------------------------------------------------------------------

  /** Credits with days left that lapse within a week: the person is told once. */
  async remindExpiring(now: Date): Promise<number> {
    const today = this.today(now);
    const due = await this.repo.creditsExpiring(today, addDaysToKey(today, EXPIRY_NOTICE_DAYS));
    if (!due.length) return 0;
    const ids = [...new Set(due.map((c) => c.userId))];
    const [credits, uses] = await Promise.all([
      this.repo.creditsOf(ids),
      this.repo.compOffUsesOf(ids),
    ]);
    const noticed: string[] = [];
    for (const id of ids) {
      const alloc = allocateCompOff(
        lotsOf(credits.filter((c) => c.userId === id)),
        uses.get(id) ?? [],
        today,
      );
      for (const c of due.filter((x) => x.userId === id)) {
        noticed.push(c.id);
        const left = alloc.lots.find((l) => l.id === c.id)?.remainingUnits ?? 0;
        if (left <= 0 || !c.expiresOn) continue;
        await this.tell(
          [id],
          COMPOFF_NOTICE.COMPOFF_EXPIRING,
          expiringCopy({ units: left, expiresOn: c.expiresOn, workedDate: c.workedDate }),
          null,
        );
      }
    }
    await this.repo.markExpiryNoticed(noticed, now);
    return noticed.length;
  }

  private async person(id: string): Promise<ShiftPerson> {
    const p = (await this.people.any([id])).get(id);
    if (!p || !p.active) throw new NotFoundError('Unknown person');
    return p;
  }

  private async changed(userId: string): Promise<void> {
    await this.events
      .publish(CompOffChangedEvent.eventName, new CompOffChangedEvent(userId))
      .catch(() => undefined);
  }

  private async tell(
    to: string[],
    type: string,
    copy: { title: string; body: string },
    fromUserId: string | null,
  ) {
    try {
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent(to, type, copy.title, copy.body, fromUserId),
      );
    } catch (err) {
      this.logger.warn(`comp off notice ${type} failed: ${(err as Error).message}`);
    }
  }
}
