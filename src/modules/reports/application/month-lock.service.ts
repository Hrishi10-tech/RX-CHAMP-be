import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, ForbiddenError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
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
 * Locking a month for payroll (SPEC 1.9): a Super Admin locks it once nothing
 * dated in it is PENDING; the everyone report is stored as a snapshot; reports
 * then read the snapshot and decisions on items dated in it are refused
 * (409 MONTH_LOCKED) until a Super Admin unlocks it.
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

  private assertSuperAdmin(me: AuthenticatedUser): void {
    if (me.role !== Role.SUPER_ADMIN)
      throw new ForbiddenError('Only a Super Admin can lock or unlock a month.');
  }

  async status(me: AuthenticatedUser, month: string, now: Date): Promise<MonthLockView> {
    await this.reports.assertMonthInRange(month, now);
    let pending: number;
    if (me.role === Role.SUPER_ADMIN) {
      pending = await this.approvals.pendingInMonth(month);
    } else {
      const dates = monthDates(month);
      const team = await this.scope.scope(me, {
        fromDate: dates[0],
        toDate: dates[dates.length - 1],
      });
      pending = await this.approvals.pendingInMonth(
        month,
        team.map((p) => p.id),
      );
    }
    const lock = await this.store.findLock(month);
    return this.view(month, lock, pending);
  }

  async lock(me: AuthenticatedUser, month: string, now: Date): Promise<MonthLockView> {
    this.assertSuperAdmin(me);
    await this.reports.assertMonthInRange(month, now);
    if (month >= dateKeyInZone(now, appTimezone()).slice(0, 7)) {
      throw new ConflictError(
        `${month} has not ended yet. Lock it from the 1st of next month.`,
        'MONTH_NOT_ENDED',
      ).withDetails({ month });
    }
    const result = await this.store.lockMonth(month, me.id, () => this.snapshot(month, now));
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
    if (result.created) this.logger.log(`${month} locked by ${me.id}`);
    return this.view(month, result.lock, 0);
  }

  async unlock(me: AuthenticatedUser, month: string, now: Date): Promise<MonthLockView> {
    this.assertSuperAdmin(me);
    await this.reports.assertMonthInRange(month, now);
    if (await this.store.unlockMonth(month)) this.logger.log(`${month} unlocked by ${me.id}`);
    return this.view(month, null, await this.approvals.pendingInMonth(month));
  }

  /** The everyone report and each person's month, as they stand now. */
  private async snapshot(month: string, now: Date): Promise<MonthSnapshot> {
    const dates = monthDates(month);
    const everyone = await this.reader.listPeople({});
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
