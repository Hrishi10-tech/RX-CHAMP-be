import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@shared/exceptions/app.exception';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { WorkdayChangedEvent } from '@shared/events/workday-changed.event';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { isAdminLike, requireOrg } from '@shared/tenancy';
import { buildMeta, PaginationMeta } from '@shared/utils/pagination';
import { addDaysToKey, appTimezone, dateKeyInZone, startOfDayInZone } from '@shared/utils/timezone';
import { monthOf } from '@shared/database/month-lock';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { assertApprover } from '@modules/shifts/application/approval-scope';
import { BreakApprovalPolicy } from '@modules/shifts/application/break-approval.policy';
import { pendingClock } from '@modules/shifts/infrastructure/prisma-break-record.repository';
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
  awayCategory,
  awayDetail,
  awayTitle,
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
import { AWAY_REPOSITORY, AwayRepository, AwayRow } from '../domain/away.repository';
import {
  MEETING_RECORD_REPOSITORY,
  MeetingRecordRepository,
  MeetingRecordRow,
} from '../domain/meeting-record.repository';
import { meetingDecidedCopy, NOTICE } from '../domain/notice-copy';
import { DUE_SOON_MS, slaState } from '../domain/sla';
import { approverScopeOf } from './approver-scope';
import { ApprovalPathType, ApprovalsListQueryDto } from './dto/approvals.dto';
import { meetingView, MeetingsService } from './meetings.service';
import {
  ApprovalItemView,
  ApprovalPersonLite,
  AwayItemView,
  ApprovalsSummaryView31,
  BulkApproveResult31,
} from './worktime.types';

const DECIDED: ('APPROVED' | 'REJECTED')[] = ['APPROVED', 'REJECTED'];

function personLite(p: ShiftPerson | undefined, fallbackId: string): ApprovalPersonLite {
  if (!p) return { id: fallbackId, name: 'Former user', email: '', role: 'USER', department: null };
  return { id: p.id, name: personName(p), email: p.email, role: p.role, department: p.department };
}

/** month_locks key of an item, as lockedMonths answers it. */
function lockKey(companyId: string | null | undefined, date: string): string {
  return `${companyId ?? '-'}|${monthOf(date)}`;
}

/**
 * One approvals inbox for break, meeting and (4.0) away records (SPEC 1.7, 3.4;
 * docs/4.0/SPEC.md 1.3). Routing is BreakApprovalPolicy's: Staff to the Managers
 * of their department (and the Admin), Managers to the Admin, Admins need none.
 * Nobody decides their own. Lists and decisions never leave the caller's
 * organisation. Decisions are conditional updates, refused in a locked month.
 */
@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    @Inject(APPROVALS_READER) private readonly reader: ApprovalsReader,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly breaks: BreakRecordRepository,
    @Inject(MEETING_RECORD_REPOSITORY) private readonly meetings: MeetingRecordRepository,
    @Inject(AWAY_REPOSITORY) private readonly away: AwayRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly breakApprovals: BreakApprovalsUseCase,
    private readonly meetingService: MeetingsService,
    private readonly settings: AppSettingsService,
  ) {}

  private assertApprover(me: AuthenticatedUser): void {
    assertApprover(me);
  }

  /**
   * A Manager: Staff in their departments (mine and all alike). An Admin or Super
   * Admin: mine = waiting for the Admin or escalated; all = the organisation.
   */
  scopeFor(me: AuthenticatedUser, scope: 'mine' | 'all' = 'mine'): ApprovalScope {
    requireOrg(me);
    const out = approverScopeOf(me, scope);
    if (!out) throw new ForbiddenError('Only managers and admins decide approvals.');
    return out;
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
        this.settings.get(requireOrg(me)),
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

  /** The subject of an item, after checking the caller may see it (404 otherwise). */
  private async subjectOf(
    me: AuthenticatedUser,
    userId: string,
    what: string,
  ): Promise<ShiftPerson> {
    const [subject] = await this.people.findAnyByIds([userId]);
    if (!subject || !BreakApprovalPolicy.canView(me, { userId }, subject)) {
      throw new NotFoundError(`Unknown ${what}`);
    }
    return subject;
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
      await this.touched(row.userId);
      return this.breakItem(me, row, now);
    }
    if (type === 'away') {
      const row = await this.reopenAway(me, id, now);
      await this.touched(row.userId);
      return this.awayItem(me, row, now);
    }
    const m = await this.meetings.findById(id);
    if (!m) throw new NotFoundError('Unknown meeting');
    const subject = await this.subjectOf(me, m.userId, 'meeting');
    if (!BreakApprovalPolicy.canDecide(me, m, subject))
      throw new ForbiddenError('This meeting is not yours to decide.');
    if (!DECIDED.includes(m.approvalStatus as 'APPROVED')) {
      throw new ConflictError(
        'Only an approved or rejected meeting can be reopened.',
        'NOT_DECIDED',
      );
    }
    if (!isAdminLike(me) && m.decidedById !== me.id) {
      throw new ForbiddenError('Only the person who decided it, or the admin, can reopen it.');
    }
    const updated = await this.meetings.decide(id, DECIDED, {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
    });
    if (!updated) throw new ConflictError('It changed meanwhile. Refresh and try again.', 'STALE');
    await this.touched(updated.userId);
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
        const done = await this.decideRow(
          me,
          item.type,
          item.id,
          'APPROVED',
          cleanReason(note),
          now,
        );
        await this.touched(done.row.userId);
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
    await this.touched(decided.row.userId);
    if (decided.type === 'BREAK') return this.breakItem(me, decided.row, now);
    if (decided.type === 'AWAY') return this.awayItem(me, decided.row, now);
    return this.meetingItem(me, decided.row, now);
  }

  /** Away decisions (4.0): the same rules as breaks and meetings. */
  private async decideAway(
    me: AuthenticatedUser,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
    now: Date,
  ): Promise<AwayRow> {
    const found = await this.away.findById(id);
    if (!found) throw new NotFoundError('Unknown away time');
    const subject = await this.subjectOf(me, found.userId, 'away time');
    if (found.userId === me.id) throw new ForbiddenError("You can't decide your own away time.");
    if (!BreakApprovalPolicy.canDecide(me, found, subject)) {
      throw new ForbiddenError('This is waiting for someone else to decide.');
    }
    if (found.status !== 'PENDING') {
      throw new ConflictError(
        found.status === 'APPROVED' || found.status === 'REJECTED'
          ? `Already ${found.status.toLowerCase()}.`
          : 'This needs no approval.',
        'ALREADY_DECIDED',
      );
    }
    const updated = await this.away.decide(id, ['PENDING'], {
      status,
      decidedById: me.id,
      decidedAt: now,
      note,
    });
    if (!updated)
      throw new ConflictError('Someone else decided it a moment ago.', 'ALREADY_DECIDED');
    await this.awayDecided(updated, me.id);
    return updated;
  }

  private async reopenAway(me: AuthenticatedUser, id: string, now: Date): Promise<AwayRow> {
    const found = await this.away.findById(id);
    if (!found) throw new NotFoundError('Unknown away time');
    const subject = await this.subjectOf(me, found.userId, 'away time');
    if (!BreakApprovalPolicy.canDecide(me, found, subject)) {
      throw new ForbiddenError('This is not yours to decide.');
    }
    if (found.status !== 'APPROVED' && found.status !== 'REJECTED') {
      throw new ConflictError('Only an approved or rejected item can be reopened.', 'NOT_DECIDED');
    }
    if (!isAdminLike(me) && found.decidedById !== me.id) {
      throw new ForbiddenError('Only the person who decided it, or the admin, can reopen it.');
    }
    const sla = (await this.settings.forUser(found.userId)).approvalSlaHours;
    const updated = await this.away.decide(id, ['APPROVED', 'REJECTED'], {
      status: 'PENDING',
      decidedById: null,
      decidedAt: null,
      note: null,
      dueAt: pendingClock(now, sla).dueAt,
    });
    if (!updated) throw new ConflictError('It changed meanwhile. Refresh and try again.', 'STALE');
    return updated;
  }

  private async awayDecided(a: AwayRow, deciderId: string): Promise<void> {
    try {
      const decider = await this.people.findById(deciderId);
      const minutes = Math.max(1, Math.round((a.seconds ?? 0) / 60));
      const approved = a.status === 'APPROVED';
      const title = approved ? 'Away time approved' : 'Away time not approved';
      const by = decider ? personName(decider) : 'Your manager';
      const body = approved
        ? `${by} approved ${minutes} min on ${a.date}. It counts as focus time.`
        : `${by} did not approve ${minutes} min on ${a.date}.${a.decisionNote ? ` Note: ${a.decisionNote}` : ''}`;
      await this.events.publish(
        NoticeEvent.eventName,
        new NoticeEvent([a.userId], NOTICE.AWAY_DECIDED, title, body, deciderId),
      );
    } catch (err) {
      this.logger.warn(`away decision notice for ${a.id} failed: ${(err as Error).message}`);
    }
  }

  private async decideRow(
    me: AuthenticatedUser,
    type: ApprovalPathType,
    id: string,
    status: 'APPROVED' | 'REJECTED',
    note: string | null,
    now: Date,
  ): Promise<
    | { type: 'BREAK'; row: BreakRecordRow }
    | { type: 'MEETING'; row: MeetingRecordRow }
    | { type: 'AWAY'; row: AwayRow }
  > {
    this.assertApprover(me);
    if (type === 'break') {
      return { type: 'BREAK', row: await this.breakApprovals.decideRecord(me, id, status, note) };
    }
    if (type === 'away')
      return { type: 'AWAY', row: await this.decideAway(me, id, status, note, now) };
    const found = await this.meetings.findById(id);
    if (!found) throw new NotFoundError('Unknown meeting');
    const subject = await this.subjectOf(me, found.userId, 'meeting');
    // A meeting whose presence session closed another way is ended first.
    if (found.mode === 'LIVE' && !found.endedAt)
      await this.meetingService.heal([found.userId], now);
    const m = (await this.meetings.findById(id)) ?? found;
    if (m.userId === me.id) throw new ForbiddenError("You can't decide your own meeting.");
    if (!BreakApprovalPolicy.canDecide(me, m, subject)) {
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

  /** Tell the person's agent to re-read today and History (4.0: live History). */
  private async touched(userId: string): Promise<void> {
    try {
      await this.events.publish(
        WorkdayChangedEvent.eventName,
        new WorkdayChangedEvent([userId], 'DECISION'),
      );
    } catch (err) {
      this.logger.warn(`workday push for ${userId} failed: ${(err as Error).message}`);
    }
  }

  // ---- Views ----------------------------------------------------------------------

  private async breakItem(
    me: AuthenticatedUser,
    row: BreakRecordRow,
    now: Date,
  ): Promise<ApprovalItemView> {
    return (await this.build(me, [row], [], [], [{ type: 'BREAK', id: row.id }], now))[0];
  }

  private async awayItem(
    me: AuthenticatedUser,
    row: AwayRow,
    now: Date,
  ): Promise<ApprovalItemView> {
    return (await this.build(me, [], [], [row], [{ type: 'AWAY', id: row.id }], now))[0];
  }

  private async meetingItem(
    me: AuthenticatedUser,
    row: MeetingRecordRow,
    now: Date,
  ): Promise<ApprovalItemView> {
    return (await this.build(me, [], [row], [], [{ type: 'MEETING', id: row.id }], now))[0];
  }

  /** Loads the referenced records in bulk and builds their views in `refs` order. */
  async views(me: AuthenticatedUser, refs: ApprovalRef[], now: Date): Promise<ApprovalItemView[]> {
    if (!refs.length) return [];
    const [breaks, meetings, away] = await Promise.all([
      this.breaks.listByIds(refs.filter((r) => r.type === 'BREAK').map((r) => r.id)),
      this.meetings.listByIds(refs.filter((r) => r.type === 'MEETING').map((r) => r.id)),
      this.away.listByIds(refs.filter((r) => r.type === 'AWAY').map((r) => r.id)),
    ]);
    return this.build(me, breaks, meetings, away, refs, now);
  }

  private async build(
    me: AuthenticatedUser,
    breaks: BreakRecordRow[],
    meetings: MeetingRecordRow[],
    away: AwayRow[],
    refs: ApprovalRef[],
    now: Date,
  ): Promise<ApprovalItemView[]> {
    const ids = new Set<string>();
    for (const r of [...breaks, ...meetings, ...away]) {
      ids.add(r.userId);
      if (r.decidedById) ids.add(r.decidedById);
    }
    const people = await this.people.findAnyByIds([...ids]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const all = [...breaks, ...meetings, ...away];
    const locked = await this.reader.lockedMonths(
      all.map((r) => byId.get(r.userId)?.companyId ?? '').filter(Boolean),
      all.map((r) => monthOf(r.date)),
    );
    const isLocked = (userId: string, date: string) =>
      locked.has(lockKey(byId.get(userId)?.companyId, date));
    const names = new Map(people.map((p) => [p.id, personName(p)]));
    const breakById = new Map(breaks.map((b) => [b.id, b]));
    const meetingById = new Map(meetings.map((m) => [m.id, m]));
    const awayById = new Map(away.map((a) => [a.id, a]));
    const tz = appTimezone();
    const out: ApprovalItemView[] = [];
    // Records that need no approval (an Admin's) are never approval items, and
    // nothing the caller may not see is ever shown.
    for (const ref of refs) {
      if (ref.type === 'AWAY') {
        const a = awayById.get(ref.id);
        if (a && (a.status === 'PENDING' || a.status === 'APPROVED' || a.status === 'REJECTED')) {
          if (!BreakApprovalPolicy.canView(me, a, byId.get(a.userId))) continue;
          out.push(
            this.awayViewOf(me, a, a.status, byId, names, isLocked(a.userId, a.date), tz, now),
          );
        }
        continue;
      }
      if (ref.type === 'BREAK') {
        const r = breakById.get(ref.id);
        if (r && r.approvalStatus !== 'NOT_REQUIRED') {
          if (!BreakApprovalPolicy.canView(me, r, byId.get(r.userId))) continue;
          out.push(
            this.breakView(
              me,
              r,
              r.approvalStatus,
              byId,
              names,
              isLocked(r.userId, r.date),
              tz,
              now,
            ),
          );
        }
      } else {
        const m = meetingById.get(ref.id);
        if (m && m.approvalStatus !== 'NOT_REQUIRED') {
          if (!BreakApprovalPolicy.canView(me, m, byId.get(m.userId))) continue;
          out.push(
            this.meetingViewOf(
              me,
              m,
              m.approvalStatus,
              byId,
              names,
              isLocked(m.userId, m.date),
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
      canDecide:
        r.userId !== me.id && !locked && BreakApprovalPolicy.canDecide(me, r, people.get(r.userId)),
      locked,
      break: view,
      meeting: null,
      away: null,
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
      reason: m.momSender ? `${m.agenda} · minutes by ${m.momSender}` : m.agenda,
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
        m.userId !== me.id &&
        !view.inProgress &&
        !locked &&
        BreakApprovalPolicy.canDecide(me, m, people.get(m.userId)),
      locked,
      break: null,
      meeting: view,
      away: null,
    };
  }

  private awayViewOf(
    me: AuthenticatedUser,
    a: AwayRow,
    status: DecidedStatus,
    people: Map<string, ShiftPerson>,
    names: Map<string, string>,
    locked: boolean,
    tz: string,
    now: Date,
  ): ApprovalItemView {
    const category = awayCategory(a.reasonKind);
    const seconds = a.seconds ?? 0;
    const sla = slaState(a.status, a.dueAt, now);
    const away: AwayItemView = {
      id: a.id,
      reasonKey: a.reasonKey,
      reasonKind: a.reasonKind,
      reasonLabel: a.reasonLabel,
      comment: a.comment,
      participants: a.participants.map((p) =>
        p.id ? { id: p.id, name: p.name } : { name: p.name },
      ),
      momSender: a.momSender,
      startedAt: a.startedAt.toISOString(),
      endedAt: a.endedAt?.toISOString() ?? null,
      seconds,
    };
    return {
      type: 'AWAY',
      id: a.id,
      category,
      user: personLite(people.get(a.userId), a.userId),
      date: a.date,
      title: awayTitle(a.reasonLabel, a.reasonKind, seconds),
      detail: awayDetail(
        {
          startedAt: a.startedAt,
          endedAt: a.endedAt,
          seconds,
          participants: a.participants.length,
          momSender: a.momSender,
        },
        tz,
      ),
      reason: a.comment,
      needsComment: false,
      participants: away.participants,
      startedAt: away.startedAt,
      endedAt: away.endedAt,
      inProgress: false,
      durationSec: seconds,
      effect: approvalEffect(category, status, Math.max(1, Math.round(seconds / 60))),
      status,
      createdAt: a.createdAt.toISOString(),
      dueAt: a.dueAt?.toISOString() ?? null,
      dueInSec: sla.dueInSec,
      dueSoon: sla.dueSoon,
      overdue: sla.overdue,
      escalated: !!a.escalatedAt,
      decidedAt: a.decidedAt?.toISOString() ?? null,
      decidedById: a.decidedById,
      decidedByName: a.decidedById ? (names.get(a.decidedById) ?? 'Former user') : null,
      decisionNote: a.decisionNote,
      canDecide:
        a.userId !== me.id && !locked && BreakApprovalPolicy.canDecide(me, a, people.get(a.userId)),
      locked,
      break: null,
      meeting: null,
      away,
    };
  }
}
