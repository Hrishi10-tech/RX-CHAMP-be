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
import { buildMeta, PaginationMeta } from '@shared/utils/pagination';
import { addDaysToKey, appTimezone, dateKeyInZone, startOfDayInZone } from '@shared/utils/timezone';
import { monthOf } from '@shared/database/month-lock';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakApprovalPolicy } from '@modules/shifts/application/break-approval.policy';
import { personName } from '@modules/shifts/application/break-events.service';
import { ShiftMapper } from '@modules/shifts/application/shift.mapper';
import { BreakApprovalsUseCase } from '@modules/shifts/application/use-cases/break-approvals.use-case';
import { cleanReason } from '@modules/shifts/application/use-cases/my-breaks.use-case';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
  needsComment,
  outcomeOf,
} from '@modules/shifts/domain/break-record.repository';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import {
  approvalEffect,
  breakCategory,
  breakDetail,
  breakTitle,
  meetingCategory,
  meetingDetail,
  meetingTitle,
  wholeMinutes,
} from '../domain/approval-copy';
import {
  APPROVALS_READER,
  ApprovalQuery,
  ApprovalRef,
  ApprovalScope,
  ApprovalsReader,
  DecidedStatus,
} from '../domain/approvals.reader';
import {
  MEETING_RECORD_REPOSITORY,
  MeetingRecordRepository,
  MeetingRecordRow,
} from '../domain/meeting-record.repository';
import { meetingDecidedCopy, NOTICE } from '../domain/notice-copy';
import { DUE_SOON_MS, slaState } from '../domain/sla';
import { ApprovalPathType, ApprovalsListQueryDto } from './dto/approvals.dto';
import { meetingView, MeetingsService } from './meetings.service';
import {
  ApprovalItemView,
  ApprovalPersonLite,
  ApprovalsSummaryView31,
  BulkApproveResult31,
} from './worktime.types';

const DECIDED: ('APPROVED' | 'REJECTED')[] = ['APPROVED', 'REJECTED'];

function personLite(p: ShiftPerson | undefined, fallbackId: string): ApprovalPersonLite {
  if (!p) return { id: fallbackId, name: 'Former user', email: '', role: 'USER', department: null };
  return { id: p.id, name: personName(p), email: p.email, role: p.role, department: p.department };
}

/**
 * One approvals inbox for break and meeting records (SPEC 1.7, 3.4). Routing is
 * BreakApprovalPolicy's: staff to their manager (or the Super Admin pool),
 * managers to the pool, Super Admins need none. Nobody decides their own; a
 * Manager decides what is routed to them; a Super Admin anything else, escalated
 * items included. Decisions are conditional updates, refused in a locked month.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @Inject(APPROVALS_READER) private readonly reader: ApprovalsReader,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly breaks: BreakRecordRepository,
    @Inject(MEETING_RECORD_REPOSITORY) private readonly meetings: MeetingRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly breakApprovals: BreakApprovalsUseCase,
    private readonly meetingService: MeetingsService,
    private readonly settings: AppSettingsService,
  ) {}

  private assertApprover(me: AuthenticatedUser): void {
    if (me.role !== Role.SUPER_ADMIN && me.role !== Role.MANAGER) {
      throw new ForbiddenError('Only managers and Super Admins decide approvals.');
    }
  }

  /** "mine" for a Manager is what is routed to them; a Super Admin may also ask for all. */
  private scopeFor(me: AuthenticatedUser, scope: 'mine' | 'all' = 'mine'): ApprovalScope {
    if (me.role === Role.MANAGER) return { kind: 'APPROVER', approverId: me.id };
    return scope === 'all' ? { kind: 'ALL' } : { kind: 'SUPER_ADMIN_MINE', approverId: me.id };
  }

  // ---- Reading ------------------------------------------------------------------

  async list(
    me: AuthenticatedUser,
    q: ApprovalsListQueryDto,
    now: Date,
  ): Promise<{ items: ApprovalItemView[]; meta: PaginationMeta }> {
    this.assertApprover(me);
    await this.meetingService.heal(null, now);
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const status = q.status ?? 'PENDING';
    const statuses: DecidedStatus[] = q.overdue
      ? ['PENDING']
      : status === 'ALL'
        ? ['PENDING', 'APPROVED', 'REJECTED']
        : status === 'DECIDED'
          ? ['APPROVED', 'REJECTED']
          : [status];
    const query: ApprovalQuery = {
      scope: this.scopeFor(me, q.scope),
      statuses,
      type: q.type,
      category: q.category,
      overdueAt: q.overdue ? now : undefined,
      date: q.date,
      userId: q.userId,
      skip: (page - 1) * limit,
      take: limit,
    };
    const { total, refs } = await this.reader.list(query);
    return { items: await this.views(me, refs, now), meta: buildMeta(total, page, limit) };
  }

  async summary(me: AuthenticatedUser, now: Date): Promise<ApprovalsSummaryView31> {
    this.assertApprover(me);
    await this.meetingService.heal(null, now);
    const scope = this.scopeFor(me);
    const tz = appTimezone();
    const today = dateKeyInZone(now, tz);
    const dayStart = startOfDayInZone(today, tz);
    const dayEnd = startOfDayInZone(addDaysToKey(today, 1), tz);
    const pending: ApprovalQuery = { scope, statuses: ['PENDING'] };
    const [all, dueSoon, overdue, escalated, approvedToday, rejectedToday, settings] =
      await Promise.all([
        this.reader.count(pending),
        this.reader.count({
          ...pending,
          dueWithin: { from: now, to: new Date(now.getTime() + DUE_SOON_MS) },
        }),
        this.reader.count({ ...pending, overdueAt: now }),
        this.reader.count({ ...pending, escalatedOnly: true }),
        this.reader.countDecidedBetween(scope, 'APPROVED', dayStart, dayEnd),
        this.reader.countDecidedBetween(scope, 'REJECTED', dayStart, dayEnd),
        this.settings.get(),
      ]);
    return {
      pending: all,
      dueSoon,
      overdue,
      escalated,
      approvedToday,
      rejectedToday,
      slaHours: settings.approvalSlaHours,
    };
  }

  /** GET /approvals/me: the caller's own items of the last `days` days, pending first. */
  async mine(
    me: AuthenticatedUser,
    days: number,
    now: Date,
  ): Promise<{ items: ApprovalItemView[] }> {
    await this.meetingService.heal([me.id], now);
    const span = Math.min(31, Math.max(1, Math.floor(days)));
    const today = dateKeyInZone(now, appTimezone());
    const { refs } = await this.reader.list({
      scope: { kind: 'SUBJECT', userId: me.id },
      statuses: ['PENDING', 'APPROVED', 'REJECTED'],
      fromDate: addDaysToKey(today, -(span - 1)),
      take: 300,
    });
    return { items: await this.views(me, refs, now) };
  }

  /** Items of these people dated in a range, for reports (no paging). */
  async itemsFor(
    me: AuthenticatedUser,
    userIds: string[],
    fromDate: string,
    toDate: string,
    now: Date,
  ): Promise<ApprovalItemView[]> {
    if (!userIds.length) return [];
    const { refs } = await this.reader.list({
      scope: { kind: 'ALL' },
      statuses: ['PENDING', 'APPROVED', 'REJECTED'],
      userIds,
      fromDate,
      toDate,
      take: 1000,
    });
    return this.views(me, refs, now);
  }

  // ---- Deciding -----------------------------------------------------------------

  async approve(
    me: AuthenticatedUser,
    type: ApprovalPathType,
    id: string,
    note: string | undefined,
    now: Date,
  ): Promise<ApprovalItemView> {
    return this.decide(me, type, id, 'APPROVED', cleanReason(note), now);
  }

  async reject(
    me: AuthenticatedUser,
    type: ApprovalPathType,
    id: string,
    note: string | undefined,
    now: Date,
  ): Promise<ApprovalItemView> {
    const clean = cleanReason(note);
    if (!clean || clean.length < 3) {
      throw new ValidationError(
        'Say why it was rejected (3 characters or more). The person sees this note.',
        'NOTE_REQUIRED',
      );
    }
    return this.decide(me, type, id, 'REJECTED', clean, now);
  }

  async reopen(
    me: AuthenticatedUser,
    type: ApprovalPathType,
    id: string,
    now: Date,
  ): Promise<ApprovalItemView> {
    this.assertApprover(me);
    if (type === 'break') {
      const row = await this.breakApprovals.reopenRecord(me, id);
      return this.breakItem(me, row, now);
    }
    const m = await this.meetings.findById(id);
    if (!m) throw new NotFoundError('Unknown meeting');
    if (!BreakApprovalPolicy.canDecide(me, m))
      throw new ForbiddenError('This meeting is not yours to decide.');
    if (!DECIDED.includes(m.approvalStatus as 'APPROVED')) {
      throw new ConflictError(
        'Only an approved or rejected meeting can be reopened.',
        'NOT_DECIDED',
      );
    }
    if (me.role !== Role.SUPER_ADMIN && m.decidedById !== me.id) {
      throw new ForbiddenError('Only the person who decided it, or a Super Admin, can reopen it.');
    }
    const updated = await this.meetings.decide(id, DECIDED, {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
    });
    if (!updated) throw new ConflictError('It changed meanwhile. Refresh and try again.', 'STALE');
    return this.meetingItem(me, updated, now);
  }

  async bulkApprove(
    me: AuthenticatedUser,
    items: { type: ApprovalPathType; id: string }[],
    note: string | undefined,
    now: Date,
  ): Promise<BulkApproveResult31> {
    this.assertApprover(me);
    const approved: BulkApproveResult31['approved'] = [];
    const skipped: BulkApproveResult31['skipped'] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await this.decideRow(me, item.type, item.id, 'APPROVED', cleanReason(note), now);
        approved.push({ type: item.type, id: item.id });
      } catch (err) {
        skipped.push({ type: item.type, id: item.id, reason: (err as Error).message });
      }
    }
    return { approved, skipped };
  }

  private async decide(
    me: AuthenticatedUser,
    type: ApprovalPathType,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
    now: Date,
  ): Promise<ApprovalItemView> {
    const decided = await this.decideRow(me, type, id, status, note, now);
    return decided.type === 'BREAK'
      ? this.breakItem(me, decided.row, now)
      : this.meetingItem(me, decided.row, now);
  }

  private async decideRow(
    me: AuthenticatedUser,
    type: ApprovalPathType,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
    now: Date,
  ): Promise<{ type: 'BREAK'; row: BreakRecordRow } | { type: 'MEETING'; row: MeetingRecordRow }> {
    this.assertApprover(me);
    if (type === 'break') {
      return { type: 'BREAK', row: await this.breakApprovals.decideRecord(me, id, status, note) };
    }
    const found = await this.meetings.findById(id);
    if (!found) throw new NotFoundError('Unknown meeting');
    // A meeting whose presence session closed another way is ended first.
    if (found.mode === 'LIVE' && !found.endedAt)
      await this.meetingService.heal([found.userId], now);
    const m = (await this.meetings.findById(id)) ?? found;
    if (m.userId === me.id) throw new ForbiddenError("You can't decide your own meeting.");
    if (!BreakApprovalPolicy.canDecide(me, m)) {
      throw new ForbiddenError('This meeting is waiting for someone else to decide.');
    }
    if (m.approvalStatus !== 'PENDING') {
      throw new ConflictError(
        m.approvalStatus === 'NOT_REQUIRED'
          ? 'This meeting needs no approval.'
          : `Already ${m.approvalStatus.toLowerCase()}.`,
        'ALREADY_DECIDED',
      );
    }
    if (m.mode === 'LIVE' && !m.endedAt) {
      throw new ConflictError(
        'This meeting is still running. Decide it once it has ended.',
        'MEETING_IN_PROGRESS',
      );
    }
    const updated = await this.meetings.decide(id, ['PENDING'], {
      status,
      decidedById: me.id,
      decidedAt: now,
      note,
    });
    if (!updated)
      throw new ConflictError('Someone else decided it a moment ago.', 'ALREADY_DECIDED');
    await this.meetingDecided(updated, me.id);
    return { type: 'MEETING', row: updated };
  }

  private async meetingDecided(m: MeetingRecordRow, deciderId: string): Promise<void> {
    try {
      const decider = await this.people.findById(deciderId);
      const copy = meetingDecidedCopy({
        approved: m.approvalStatus === 'APPROVED',
        date: m.date,
        deciderName: decider ? personName(decider) : 'Your manager',
        note: m.decisionNote,
      });
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([m.userId], NOTICE.MEETING_DECIDED, copy.title, copy.body, deciderId),
      );
    } catch (err) {
      this.logger.warn(`meeting decision notice for ${m.id} failed: ${(err as Error).message}`);
    }
  }

  // ---- Views ----------------------------------------------------------------------

  private async breakItem(
    me: AuthenticatedUser,
    row: BreakRecordRow,
    now: Date,
  ): Promise<ApprovalItemView> {
    return (await this.build(me, [row], [], [{ type: 'BREAK', id: row.id }], now))[0];
  }

  private async meetingItem(
    me: AuthenticatedUser,
    row: MeetingRecordRow,
    now: Date,
  ): Promise<ApprovalItemView> {
    return (await this.build(me, [], [row], [{ type: 'MEETING', id: row.id }], now))[0];
  }

  /** Loads the referenced records in bulk and builds their views in `refs` order. */
  async views(me: AuthenticatedUser, refs: ApprovalRef[], now: Date): Promise<ApprovalItemView[]> {
    if (!refs.length) return [];
    const [breaks, meetings] = await Promise.all([
      this.breaks.listByIds(refs.filter((r) => r.type === 'BREAK').map((r) => r.id)),
      this.meetings.listByIds(refs.filter((r) => r.type === 'MEETING').map((r) => r.id)),
    ]);
    return this.build(me, breaks, meetings, refs, now);
  }

  private async build(
    me: AuthenticatedUser,
    breaks: BreakRecordRow[],
    meetings: MeetingRecordRow[],
    refs: ApprovalRef[],
    now: Date,
  ): Promise<ApprovalItemView[]> {
    const ids = new Set<string>();
    for (const r of [...breaks, ...meetings]) {
      ids.add(r.userId);
      if (r.decidedById) ids.add(r.decidedById);
    }
    const months = [...breaks, ...meetings].map((r) => monthOf(r.date));
    const [people, locked] = await Promise.all([
      this.people.findAnyByIds([...ids]),
      this.reader.lockedMonths(months),
    ]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const names = new Map(people.map((p) => [p.id, personName(p)]));
    const breakById = new Map(breaks.map((b) => [b.id, b]));
    const meetingById = new Map(meetings.map((m) => [m.id, m]));
    const tz = appTimezone();
    const out: ApprovalItemView[] = [];
    // Records that need no approval (a Super Admin's) are never approval items.
    for (const ref of refs) {
      if (ref.type === 'BREAK') {
        const r = breakById.get(ref.id);
        if (r && r.approvalStatus !== 'NOT_REQUIRED') {
          out.push(
            this.breakView(
              me,
              r,
              r.approvalStatus,
              byId,
              names,
              locked.has(monthOf(r.date)),
              tz,
              now,
            ),
          );
        }
      } else {
        const m = meetingById.get(ref.id);
        if (m && m.approvalStatus !== 'NOT_REQUIRED') {
          out.push(
            this.meetingViewOf(
              me,
              m,
              m.approvalStatus,
              byId,
              names,
              locked.has(monthOf(m.date)),
              tz,
              now,
            ),
          );
        }
      }
    }
    return out;
  }

  private breakView(
    me: AuthenticatedUser,
    r: BreakRecordRow,
    status: DecidedStatus,
    people: Map<string, ShiftPerson>,
    names: Map<string, string>,
    locked: boolean,
    tz: string,
    now: Date,
  ): ApprovalItemView {
    const view = ShiftMapper.recordView(r, now, names);
    const category = breakCategory({
      outcome: outcomeOf(r),
      overrunAsked: r.overrunAsked ?? false,
      timing: r.timing,
    });
    const minutes =
      category === 'BREAK_OVERRUN'
        ? wholeMinutes(view.overrunSec)
        : category === 'BREAK_SKIP' || category === 'BREAK_AUTO_SKIP'
          ? (r.durationMin ?? 0)
          : 0;
    const sla = slaState(r.approvalStatus, r.dueAt ?? null, now);
    const text = { ...r, overrunSec: view.overrunSec };
    return {
      type: 'BREAK',
      id: r.id,
      category,
      user: personLite(people.get(r.userId), r.userId),
      date: r.date,
      title: breakTitle(category, text),
      detail: breakDetail(category, text, tz, now),
      reason: category === 'BREAK_OVERRUN' ? (r.overrunReason ?? r.reason) : r.reason,
      needsComment: needsComment(r),
      participants: [],
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
      inProgress: view.inProgress,
      durationSec: view.tookSec,
      effect: approvalEffect(category, r.approvalStatus, minutes),
      status,
      createdAt: r.createdAt.toISOString(),
      dueAt: r.dueAt?.toISOString() ?? null,
      dueInSec: sla.dueInSec,
      dueSoon: sla.dueSoon,
      overdue: sla.overdue,
      escalated: !!r.escalatedAt,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decidedById: r.decidedById ?? null,
      decidedByName: view.decidedByName,
      decisionNote: r.decisionNote,
      canDecide: r.userId !== me.id && !locked && BreakApprovalPolicy.canDecide(me, r),
      locked,
      break: view,
      meeting: null,
    };
  }

  private meetingViewOf(
    me: AuthenticatedUser,
    m: MeetingRecordRow,
    status: DecidedStatus,
    people: Map<string, ShiftPerson>,
    names: Map<string, string>,
    locked: boolean,
    tz: string,
    now: Date,
  ): ApprovalItemView {
    const view = meetingView(m, now, names);
    const category = meetingCategory(m.mode);
    const sla = slaState(m.approvalStatus, m.dueAt, now);
    return {
      type: 'MEETING',
      id: m.id,
      category,
      user: personLite(people.get(m.userId), m.userId),
      date: m.date,
      title: meetingTitle(m.agenda),
      detail: meetingDetail(
        {
          startedAt: m.startedAt,
          endedAt: m.endedAt,
          durationSec: view.durationSec,
          participants: m.participants.length,
        },
        tz,
      ),
      reason: m.agenda,
      needsComment: false,
      participants: view.participants,
      startedAt: view.startedAt,
      endedAt: view.endedAt,
      inProgress: view.inProgress,
      durationSec: view.durationSec,
      effect: approvalEffect(category, m.approvalStatus, wholeMinutes(view.durationSec)),
      status,
      createdAt: m.createdAt.toISOString(),
      dueAt: view.dueAt,
      dueInSec: sla.dueInSec,
      dueSoon: sla.dueSoon,
      overdue: sla.overdue,
      escalated: !!m.escalatedAt,
      decidedAt: view.decidedAt,
      decidedById: m.decidedById ?? null,
      decidedByName: view.decidedByName,
      decisionNote: m.decisionNote,
      canDecide:
        m.userId !== me.id && !view.inProgress && !locked && BreakApprovalPolicy.canDecide(me, m),
      locked,
      break: null,
      meeting: view,
    };
  }
}
