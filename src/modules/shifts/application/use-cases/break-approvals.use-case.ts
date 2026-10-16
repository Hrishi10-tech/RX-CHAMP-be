import { Inject, Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { Role } from '@shared/rbac/roles.enum';
import { buildMeta, PaginationMeta } from '@shared/utils/pagination';
import { dateKeyInZone } from '@shared/utils/timezone';
import {
  ApprovalFilter,
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
} from '../../domain/break-record.repository';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '../../domain/shift-people.reader';
import { BreakApprovalStatus } from '../../domain/shift.types';
import { BreakApprovalPolicy } from '../break-approval.policy';
import { BreakDayService } from '../break-day.service';
import { BreakEvents, personName } from '../break-events.service';
import { ApprovalsQueryDto, BulkApproveDto } from '../dto';
import { ShiftMapper } from '../shift.mapper';
import {
  ApprovalItemView,
  ApprovalPersonView,
  ApprovalsSummaryView,
  BulkApproveResult,
} from '../shifts.types';
import { cleanReason } from './my-breaks.use-case';

const DECIDED: BreakApprovalStatus[] = ['APPROVED', 'REJECTED'];

/**
 * Daily approval of off-schedule breaks.
 *
 *   Staff break     -> their Manager decides (or the Super Admin pool when they
 *                      have no active manager).
 *   Manager break   -> any Super Admin decides.
 *   Super Admin     -> nothing to approve.
 *
 * A Super Admin may decide anything except their own; a Manager only what was
 * routed to them. Decisions are conditional updates, so two approvers acting at
 * once cannot both win.
 */
@Injectable()
export class BreakApprovalsUseCase {
  constructor(
    @Inject(BREAK_RECORD_REPOSITORY) private readonly records: BreakRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
    private readonly events: BreakEvents,
  ) {}

  private assertApprover(me: AuthenticatedUser): void {
    if (me.role !== Role.SUPER_ADMIN && me.role !== Role.MANAGER) {
      throw new ForbiddenError('Only managers and super admins approve breaks.');
    }
  }

  private today(): string {
    return dateKeyInZone(new Date(), this.days.timezone);
  }

  /** The approver part of the filter: what counts as "mine" (or everything). */
  private scopeFilter(me: AuthenticatedUser, scope: 'mine' | 'all' = 'mine'): ApprovalFilter {
    if (me.role === Role.MANAGER) return { approverId: me.id };
    if (scope === 'all') return {};
    return { approverAny: { approverId: me.id, approverRole: 'SUPER_ADMIN' } };
  }

  async list(
    me: AuthenticatedUser,
    q: ApprovalsQueryDto,
  ): Promise<{ items: ApprovalItemView[]; meta: PaginationMeta }> {
    this.assertApprover(me);
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const filter: ApprovalFilter = { ...this.scopeFilter(me, q.scope) };

    if (q.overdue) {
      filter.status = ['PENDING'];
      filter.beforeDate = this.today();
    } else {
      const status = q.status ?? 'PENDING';
      filter.status = status === 'ALL' ? ['PENDING', 'APPROVED', 'REJECTED'] : [status];
      if (q.date) filter.date = q.date;
    }

    const [total, rows] = await Promise.all([
      this.records.countApprovals(filter),
      this.records.listApprovals({ ...filter, skip: (page - 1) * limit, take: limit }),
    ]);
    return { items: await this.toItems(me, rows), meta: buildMeta(total, page, limit) };
  }

  async summary(me: AuthenticatedUser, date?: string): Promise<ApprovalsSummaryView> {
    this.assertApprover(me);
    const day = date ?? this.today();
    const base = this.scopeFilter(me);
    const [pendingToday, overdue, approvedToday, rejectedToday] = await Promise.all([
      this.records.countApprovals({ ...base, status: ['PENDING'], date: day }),
      this.records.countApprovals({ ...base, status: ['PENDING'], beforeDate: day }),
      this.records.countApprovals({ ...base, status: ['APPROVED'], date: day }),
      this.records.countApprovals({ ...base, status: ['REJECTED'], date: day }),
    ]);
    return { date: day, pendingToday, overdue, approvedToday, rejectedToday };
  }

  async approve(me: AuthenticatedUser, id: string, note?: string): Promise<ApprovalItemView> {
    return this.decide(me, id, 'APPROVED', cleanReason(note));
  }

  async reject(me: AuthenticatedUser, id: string, note: string): Promise<ApprovalItemView> {
    const clean = cleanReason(note);
    if (!clean || clean.length < 3) {
      throw new ValidationError(
        'Say why it was rejected; the staff member sees this note.',
        'NOTE_REQUIRED',
      );
    }
    return this.decide(me, id, 'REJECTED', clean);
  }

  async bulkApprove(me: AuthenticatedUser, dto: BulkApproveDto): Promise<BulkApproveResult> {
    this.assertApprover(me);
    const note = cleanReason(dto.note);
    const approved: string[] = [];
    const skipped: BulkApproveResult['skipped'] = [];
    for (const id of [...new Set(dto.ids)]) {
      try {
        await this.decide(me, id, 'APPROVED', note);
        approved.push(id);
      } catch (err) {
        skipped.push({ id, reason: (err as Error).message });
      }
    }
    return { approved, skipped };
  }

  /** Puts a decided break back to pending (a mis-click). The decider or a Super Admin. */
  async reopen(me: AuthenticatedUser, id: string): Promise<ApprovalItemView> {
    const updated = await this.reopenRecord(me, id);
    return (await this.toItems(me, [updated]))[0];
  }

  /**
   * The reopen rules, shared with the unified approvals (3.1). Back to PENDING
   * restarts the 48-hour clock; a locked month answers 409 MONTH_LOCKED.
   */
  async reopenRecord(me: AuthenticatedUser, id: string): Promise<BreakRecordRow> {
    this.assertApprover(me);
    const record = await this.records.findById(id);
    if (!record) throw new NotFoundError('Unknown break');
    if (!BreakApprovalPolicy.canDecide(me, record))
      throw new ForbiddenError('This break is not yours to decide.');
    if (!DECIDED.includes(record.approvalStatus)) {
      throw new ConflictError('Only an approved or rejected break can be reopened.', 'NOT_DECIDED');
    }
    if (me.role !== Role.SUPER_ADMIN && record.decidedById !== me.id) {
      throw new ForbiddenError('Only the person who decided it, or a Super Admin, can reopen it.');
    }
    const updated = await this.records.decide(id, DECIDED, {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
    });
    if (!updated) throw new ConflictError('It changed meanwhile. Refresh and try again.', 'STALE');
    return updated;
  }

  private async decide(
    me: AuthenticatedUser,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
  ): Promise<ApprovalItemView> {
    const updated = await this.decideRecord(me, id, status, note);
    return (await this.toItems(me, [updated]))[0];
  }

  /**
   * The decision rules, shared with the unified approvals (3.1): never your own,
   * a Manager only what is routed to them, a Super Admin anything else; only a
   * PENDING record; a locked month answers 409 MONTH_LOCKED.
   */
  async decideRecord(
    me: AuthenticatedUser,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
  ): Promise<BreakRecordRow> {
    this.assertApprover(me);
    const record = await this.records.findById(id);
    if (!record) throw new NotFoundError('Unknown break');
    if (record.userId === me.id) throw new ForbiddenError("You can't decide your own break.");
    if (!BreakApprovalPolicy.canDecide(me, record)) {
      throw new ForbiddenError('This break is waiting for someone else to decide.');
    }
    if (record.approvalStatus !== 'PENDING') {
      throw new ConflictError(
        record.approvalStatus === 'NOT_REQUIRED'
          ? 'This break needs no approval.'
          : `Already ${record.approvalStatus.toLowerCase()}.`,
        'ALREADY_DECIDED',
      );
    }
    const updated = await this.records.decide(id, ['PENDING'], {
      status,
      decidedById: me.id,
      decidedAt: new Date(),
      note,
    });
    if (!updated)
      throw new ConflictError('Someone else decided it a moment ago.', 'ALREADY_DECIDED');

    const meAsPerson = await this.people.findById(me.id);
    void this.events.decided(updated, { id: me.id, name: personName(meAsPerson) });
    return updated;
  }

  private async toItems(
    me: AuthenticatedUser,
    rows: BreakRecordRow[],
  ): Promise<ApprovalItemView[]> {
    if (!rows.length) return [];
    const now = new Date();
    const ids = new Set<string>();
    for (const r of rows) {
      ids.add(r.userId);
      if (r.decidedById) ids.add(r.decidedById);
    }
    const people = new Map((await this.people.findAnyByIds([...ids])).map((p) => [p.id, p]));
    const names = new Map([...people.values()].map((p) => [p.id, personName(p)]));
    return rows.map((r) => ({
      ...ShiftMapper.recordView(r, now, names),
      user: personView(people.get(r.userId), r.userId),
      canDecide: BreakApprovalPolicy.canDecide(me, r) && r.approvalStatus !== 'NOT_REQUIRED',
    }));
  }
}

export function personView(p: ShiftPerson | undefined, fallbackId: string): ApprovalPersonView {
  if (!p) return { id: fallbackId, name: 'Former user', email: '', role: 'USER', department: null };
  return { id: p.id, name: personName(p), email: p.email, role: p.role, department: p.department };
}
