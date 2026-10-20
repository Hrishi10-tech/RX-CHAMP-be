import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, ForbiddenError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { isAdminLike, requireOrg } from '@shared/tenancy';
import { appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { personName } from '@modules/shifts/application/break-events.service';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '@modules/shifts/domain/shift-people.reader';
import { PeopleScopeService } from '@modules/worktime/application/people-scope.service';
import { APPROVALS_READER, ApprovalsReader } from '@modules/worktime/domain/approvals.reader';
import { WORKTIME_READER, WorktimeReader } from '@modules/worktime/domain/worktime.reader';
import { monthDates } from '../domain/report-builder';
import { REPORT_STORE, ReportStore } from '../domain/report.store';
import { MonthLockView, MonthSnapshot } from '../domain/report.types';
import { ReportsService } from './reports.service';

/**
 * Locking a month for payroll (SPEC 1.9), per organisation since 4.0: the Admin
 * (or a Super Admin acting in the organisation) locks it once nothing of the
 * organisation dated in it is PENDING; the organisation's everyone report is
 * stored as a snapshot; reports then read the snapshot and decisions on items
 * dated in it are refused (409 MONTH_LOCKED) until it is unlocked.
 */
@Injectable()
export class MonthLockService {
  private readonly logger = new Logger(MonthLockService.name);

  constructor(
    @Inject(REPORT_STORE) private readonly store: ReportStore,
    @Inject(APPROVALS_READER) private readonly approvals: ApprovalsReader,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly scope: PeopleScopeService,
    private readonly reports: ReportsService,
  ) {}

  /** The organisation the caller may lock months of (Admin, Super Admin with one chosen). */
  private assertAdmin(me: AuthenticatedUser): string {
    if (!isAdminLike(me))
      throw new ForbiddenError('Only the organisation admin can lock or unlock a month.');
    return requireOrg(me);
  }

  async status(me: AuthenticatedUser, month: string, now: Date): Promise<MonthLockView> {
    const companyId = requireOrg(me);
    // Reading the status never fails on the range: a month with nothing to report
    // is simply open with nothing pending (or shows the lock it has).
    if (await this.reports.monthProblem(month, now)) {
      return this.view(month, await this.store.findLock(companyId, month), 0);
    }
    let pending: number;
    if (isAdminLike(me)) {
      pending = await this.approvals.pendingInMonth(companyId, month);
    } else {
      const dates = monthDates(month);
      const team = await this.scope.scope(me, {
        fromDate: dates[0],
        toDate: dates[dates.length - 1],
      });
      pending = await this.approvals.pendingInMonth(
        companyId,
        month,
        team.map((p) => p.id),
      );
    }
    const lock = await this.store.findLock(companyId, month);
    return this.view(month, lock, pending);
  }

  async lock(me: AuthenticatedUser, month: string, now: Date): Promise<MonthLockView> {
    const companyId = this.assertAdmin(me);
    await this.reports.assertMonthInRange(month, now);
    if (month >= dateKeyInZone(now, appTimezone()).slice(0, 7)) {
      throw new ConflictError(
        `${month} has not ended yet. Lock it from the 1st of next month.`,
        'MONTH_NOT_ENDED',
      ).withDetails({ month });
    }
    const result = await this.store.lockMonth(companyId, month, me.id, () =>
      this.snapshot(companyId, month, now),
    );
    if (!result.ok && result.reason === 'OPEN_SESSIONS') {
      throw new ConflictError(
        `${result.count === 1 ? '1 working day dated in ' + month + ' is' : `${result.count} working days dated in ${month} are`} ` +
          'still open. Lock the month once they have ended (End Day, or the automatic close).',
        'OPEN_SESSIONS',
      ).withDetails({ count: result.count });
    }
    if (!result.ok) {
      throw new ConflictError(
        `${result.count === 1 ? '1 item' : `${result.count} items`} dated in ${month} still ` +
          'wait for a decision. Decide them before locking the month.',
        'PENDING_APPROVALS',
      ).withDetails({ count: result.count });
    }
    if (result.created) this.logger.log(`${month} of ${companyId} locked by ${me.id}`);
    return this.view(month, result.lock, 0);
  }

  async unlock(me: AuthenticatedUser, month: string, now: Date): Promise<MonthLockView> {
    const companyId = this.assertAdmin(me);
    await this.reports.assertMonthInRange(month, now);
    if (await this.store.unlockMonth(companyId, month)) {
      this.logger.log(`${month} of ${companyId} unlocked by ${me.id}`);
    }
    return this.view(month, null, await this.approvals.pendingInMonth(companyId, month));
  }

  /** The organisation's everyone report and each person's month, as they stand now. */
  private async snapshot(companyId: string, month: string, now: Date): Promise<MonthSnapshot> {
    const dates = monthDates(month);
    const everyone = await this.reader.listPeople({ companyId, excludeRoles: ['SUPER_ADMIN'] });
    const worked = await this.reader.userIdsWithSessionsBetween(
      everyone.filter((p) => !p.active).map((p) => p.id),
      dates[0],
      dates[dates.length - 1],
    );
    const people = everyone.filter((p) => p.active || worked.has(p.id));
    const built = await this.reports.buildMonth(people, month, 'ALL', now);
    return {
      version: 1,
      generatedAt: now.toISOString(),
      team: { ...built.team, locked: true },
      persons: Object.fromEntries(built.persons.map((p) => [p.person.id, { ...p, locked: true }])),
    };
  }

  private async view(
    month: string,
    lock: { lockedById: string; lockedAt: Date } | null,
    pending: number,
  ): Promise<MonthLockView> {
    const by = lock ? (await this.people.findAnyByIds([lock.lockedById]))[0] : undefined;
    return {
      month,
      locked: !!lock,
      lockedAt: lock?.lockedAt.toISOString() ?? null,
      lockedByName: by ? personName(by) : null,
      pending,
    };
  }
}
