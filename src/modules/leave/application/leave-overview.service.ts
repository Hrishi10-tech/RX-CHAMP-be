import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { isAdminLike, orgOf } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { routeFor } from '../domain/routing';
import { LEAVE_REPOSITORY, LeaveRepository, LeaveRequestRecord } from '../domain/leave.repository';
import { daysOf } from '../domain/leave.types';
import { allocateCompOff, compOffBalanceOf, lotsOf } from '../domain/comp-off';
import { leaveDay } from '../domain/request-rules';
import { LivePolicy } from './leave-policy.service';
import { LeaveAccountsService, quotaMap } from './leave-accounts.service';
import { LeavePeopleService } from './leave-people.service';
import { LeavePolicyService } from './leave-policy.service';
import { LeaveRequestsService } from './leave-requests.service';
import { CompOffSummaryView, MyLeaveView, PersonBalanceRow, PersonLeaveView } from './leave.views';

/**
 * The read-side pages (3.4): "My leave" for everyone (portal, mobile app, agent
 * menu), one person's leave for an approver, and the balances list.
 */
@Injectable()
export class LeaveOverviewService {
  constructor(
    @Inject(LEAVE_REPOSITORY) private readonly repo: LeaveRepository,
    private readonly policies: LeavePolicyService,
    private readonly accounts: LeaveAccountsService,
    private readonly requests: LeaveRequestsService,
    private readonly people: LeavePeopleService,
  ) {}

  private policyView(me: AuthenticatedUser, now: Date) {
    return this.policies.get(orgOf(me), now).then((p) =>
      LeavePolicyService.view(p, {
        canEdit: isAdminLike(me) && !!orgOf(me),
        canRoute: isAdminLike(me) && !!orgOf(me),
        now,
      }),
    );
  }

  /** GET /leave/me */
  async my(me: AuthenticatedUser, yearQ: number | undefined, now: Date): Promise<MyLeaveView> {
    const today = dateKeyInZone(now, appTimezone());
    const thisYear = Number(today.slice(0, 4));
    const year = yearQ ?? thisYear;
    const nextYearRows = await this.repo.listRequests({
      userId: me.id,
      year: thisYear + 1,
      limit: 1,
    });
    const showNext = year === thisYear && (today.slice(5, 7) === '12' || nextYearRows.length > 0);
    const upTo = Math.max(year, showNext ? thisYear + 1 : thisYear);
    const { balances, accounts, policy } = await this.accounts.balancesOf(me.id, upTo, now);
    const records = await this.records(me.id, [
      ...new Set([year, ...(showNext ? [thisYear + 1] : [])]),
    ]);
    const views = await this.requests.views(me, records, now);
    const person = (await this.people.any([me.id])).get(me.id);
    const route = person
      ? routeFor(policy.approver, person, await this.people.routingPeople(person))
      : null;
    const waitingFor = route?.approverRole
      ? (await this.people.waitingFor([{ approverRole: route.approverRole, userId: me.id }]))[0]
      : null;
    const upcoming = views
      .filter((v) => (v.status === 'PENDING' || v.status === 'APPROVED') && v.endDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate));
    return {
      today,
      timezone: appTimezone(),
      year,
      policy: await this.policyView(me, now),
      balances: this.accounts.views(year, balances, accounts, policy, now),
      nextYear: showNext
        ? {
            year: thisYear + 1,
            balances: this.accounts.views(thisYear + 1, balances, accounts, policy, now),
          }
        : null,
      waitingFor,
      upcoming,
      requests: views.filter((v) => v.year === year),
      ledger: await this.accounts.ledger(me.id, year, balances, accounts, records),
      compOff: (await this.compOffOf([me.id], policy, now)).get(me.id),
    };
  }

  /**
   * Comp off in short for these people (3.5): one read of credits and comp off leave.
   * 4.0: each person's organisation's policy (one policy, or one per person).
   */
  async compOffOf(
    userIds: string[],
    policyOf: LivePolicy | ((userId: string) => LivePolicy),
    now: Date,
  ): Promise<Map<string, CompOffSummaryView>> {
    const today = dateKeyInZone(now, appTimezone());
    const [credits, uses] = await Promise.all([
      this.repo.creditsOf(userIds),
      this.repo.compOffUsesOf(userIds),
    ]);
    const out = new Map<string, CompOffSummaryView>();
    for (const id of new Set(userIds)) {
      const mine = credits.filter((c) => c.userId === id);
      const b = compOffBalanceOf(allocateCompOff(lotsOf(mine), uses.get(id) ?? [], today), mine);
      const policy = typeof policyOf === 'function' ? policyOf(id) : policyOf;
      out.set(id, {
        enabled: policy.compOffEnabled,
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
        validityDays: policy.compOffValidityDays,
      });
    }
    return out;
  }

  /** GET /leave/balances/:userId: one person's leave (themselves, or someone in scope). */
  async person(
    me: AuthenticatedUser,
    userId: string,
    yearQ: number | undefined,
    now: Date,
  ): Promise<PersonLeaveView> {
    const target = await this.people.visible(me, userId);
    const thisYear = Number(dateKeyInZone(now, appTimezone()).slice(0, 4));
    const year = yearQ ?? thisYear;
    const { balances, accounts, policy } = await this.accounts.balancesOf(target.id, year, now);
    const records = await this.records(target.id, [year]);
    const [refs, quotas, views, ledger] = await Promise.all([
      this.people.refs([target.id]),
      this.repo.quotasOf([target.id]),
      this.requests.views(me, records, now),
      this.accounts.ledger(target.id, year, balances, accounts, records),
    ]);
    const [clsl, elpl] = this.accounts.views(year, balances, accounts, policy, now);
    const q = quotaMap(quotas);
    const today = dateKeyInZone(now, appTimezone());
    return {
      user: refs.get(target.id)!,
      year,
      clsl,
      elpl,
      balances: [clsl, elpl],
      quota: {
        clslDaysPerYear: q.CLSL !== undefined ? daysOf(q.CLSL) : null,
        elplDaysPerYear: q.ELPL !== undefined ? daysOf(q.ELPL) : null,
      },
      upcomingDays: daysOf(
        records
          .filter((r) => r.status === 'APPROVED' || r.status === 'PENDING')
          .flatMap((r) => r.days)
          .filter((d) => d.date >= today)
          .reduce((n, d) => n + d.units, 0),
      ),
      ledger,
      requests: views,
      compOff: (await this.compOffOf([target.id], policy, now)).get(target.id),
      canAdjust:
        (me.role === Role.SUPER_ADMIN ||
          me.role === Role.ADMIN ||
          me.role === Role.SUPER_MANAGER) &&
        target.id !== me.id,
    };
  }

  /** GET /leave/balances: the people in scope with both pools for one year. */
  async balances(
    me: AuthenticatedUser,
    q: { year?: number; companyId?: string; managerId?: string; search?: string },
    now: Date,
  ): Promise<{ year: number; rows: PersonBalanceRow[]; canAdjust: boolean }> {
    const people = await this.people.scopePeople(me, q);
    const year = q.year ?? Number(dateKeyInZone(now, appTimezone()).slice(0, 4));
    const rows = await this.accounts.rows(people, year, now);
    const policyOf = await this.policies.forPeople(people, now);
    const byId = new Map(people.map((p) => [p.id, p] as const));
    const compOff = await this.compOffOf(
      people.map((p) => p.id),
      (id) => policyOf(byId.get(id)!),
      now,
    );
    for (const r of rows) r.compOff = compOff.get(r.user.id);
    rows.sort((a, b) => a.user.name.localeCompare(b.user.name));
    return {
      year,
      rows,
      // 4.0: the organisation's admins and the Super Manager.
      canAdjust:
        me.role === Role.SUPER_ADMIN || me.role === Role.SUPER_MANAGER || me.role === Role.ADMIN,
    };
  }

  private async records(userId: string, years: number[]): Promise<LeaveRequestRecord[]> {
    const rows = (
      await Promise.all(years.map((year) => this.repo.listRequests({ userId, year, limit: 300 })))
    ).flat();
    return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}
