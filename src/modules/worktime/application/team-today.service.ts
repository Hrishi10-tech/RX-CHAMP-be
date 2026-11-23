import { Inject, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { assertAnyGrant, grantsOf } from '@shared/tenancy';
import { addDaysToKey, appTimezone, dateKeyInZone } from '@shared/utils/timezone';
import { AppSettingsService } from '@modules/settings/application/app-settings.service';
import { BreakDayService } from '@modules/shifts/application/break-day.service';
import { personName } from '@modules/shifts/application/break-events.service';
import { ShiftMapper } from '@modules/shifts/application/shift.mapper';
import { outcomeOf } from '@modules/shifts/domain/break-record.repository';
import { phaseAt, shiftBounds } from '@modules/shifts/domain/break-schedule';
import { ShiftPerson } from '@modules/shifts/domain/shift-people.reader';
import { APPROVALS_READER, ApprovalsReader } from '../domain/approvals.reader';
import { dayLeaveView, expectedAfterLeave, shiftAfterLeave } from '@modules/leave/domain/day-leave';
import { expectedSecOf, isWorkdayFor, lateStartDetail } from '../domain/attendance';
import { quietHoursOf } from '../domain/hourly';
import { PersonRow, PresenceRow, WORKTIME_READER, WorktimeReader } from '../domain/worktime.reader';
import { focusOfDay, meetingsOfDay, PersonDayData } from '../domain/day';
import { WORK_SESSION_REPOSITORY, WorkSessionRepository } from '../domain/work-session.repository';
import { DayDataService } from './day-data.service';
import { PeopleScopeService } from './people-scope.service';
import { focusView, wfhDayView } from './workday.service';
import { BIOMETRIC_SOURCE } from '../domain/day';
import { DayPunch, PUNCHES_READER, PunchesReader } from '../domain/punches.reader';
import { TeamBreakStatus, TeamRowStatus, TeamTodayRow, TeamTodayView } from './worktime.types';

/** A PersonRow as the shift resolver needs it. */
export function asShiftPerson(p: PersonRow): ShiftPerson {
  return {
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    email: p.email,
    role: p.role,
    department: p.department,
    designation: p.designation,
    companyId: p.companyId,
    departmentId: p.departmentId,
    managerId: p.managerId,
    active: p.active,
    attendanceSource: p.attendanceSource ?? 'AGENT',
  };
}

/**
 * Team today (SPEC 3.5): one row per person in scope with live status, focus,
 * the three breaks, meetings, late start, pending approvals and hourly activity
 * (SQL hour buckets), for today or any day.
 */
@Injectable()
export class TeamTodayService {
  constructor(
    @Inject(APPROVALS_READER) private readonly approvals: ApprovalsReader,
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    @Inject(WORK_SESSION_REPOSITORY) private readonly sessions: WorkSessionRepository,
    private readonly scope: PeopleScopeService,
    private readonly dayData: DayDataService,
    private readonly days: BreakDayService,
    private readonly settings: AppSettingsService,
    @Inject(PUNCHES_READER) private readonly punches: PunchesReader,
  ) {}

  async today(
    me: AuthenticatedUser,
    q: { date?: string; managerId?: string; departmentId?: string },
    now: Date,
  ): Promise<TeamTodayView> {
    // 4.0: a Manager needs at least one view grant (the same rule as GET /team), and
    // hourly activity and quiet hours need the activity grant.
    assertAnyGrant(me);
    const activity = grantsOf(me).activity;
    const tz = appTimezone();
    const calendar = dateKeyInZone(now, tz);
    // Live (no date asked): each person's own working day, their open session's or
    // their shift-day of now (a night shift's early hours belong to the evening).
    const live = !q.date || q.date === calendar;
    const asked = q.date ?? calendar;
    const people = await this.scope.scope(me, {
      managerId: q.managerId,
      // One department, checked like in reports (re-audit L5).
      departmentId: q.departmentId,
      fromDate: live ? addDaysToKey(calendar, -1) : asked,
      toDate: asked,
    });
    const ids = people.map((p) => p.id);
    const [ctx, openSessions] = await Promise.all([
      this.days.context(ids),
      live && !q.date ? this.sessions.listOverlapping(ids, now, now) : Promise.resolve([]),
    ]);
    const openDate = new Map(
      openSessions.filter((s) => s.endedAt === null).map((s) => [s.userId, s.date]),
    );
    const dateOf = new Map<string, string>(
      people.map((p) => [
        p.id,
        q.date ?? openDate.get(p.id) ?? this.days.dayWith(ctx, asShiftPerson(p), now).dateKey,
      ]),
    );
    const dates = [...new Set(dateOf.values())].sort();
    const from = dates[0] ?? asked;
    const to = dates[dates.length - 1] ?? asked;
    const biometricIds = people.filter((p) => p.attendanceSource === 'BIOMETRIC').map((p) => p.id);
    const [data, buckets, pending, overdueApprovals, settings, openPresence, punches] =
      await Promise.all([
        this.dayData.load(ids, from, to, now, { heal: true }),
        activity
          ? this.dayData.bucketHours(ids, from, to, now)
          : Promise.resolve(new Map<string, readonly number[]>()),
        this.approvals.pendingByUserDate(ids, from, to, now),
        ids.length
          ? this.approvals.count({
              scope: { kind: 'ALL' },
              statuses: ['PENDING'],
              overdueAt: now,
              userIds: ids,
            })
          : Promise.resolve(0),
        this.settings.get(people[0]?.companyId ?? null),
        live
          ? this.reader.presenceOverlapping(ids, now, now)
          : Promise.resolve([] as PresenceRow[]),
        biometricIds.length
          ? this.punches.punchesOf(biometricIds, from, to)
          : Promise.resolve(new Map<string, DayPunch[]>()),
      ]);
    const pendingBy = new Map(pending.map((p) => [`${p.userId}|${p.date}`, p.pending]));
    const openBy = new Map<string, PresenceRow>();
    for (const p of openPresence) if (p.endedAt === null) openBy.set(p.userId, p);

    const rows: TeamTodayRow[] = people
      .sort((a, b) => personName(a).localeCompare(personName(b)))
      .map((p) => {
        const date = dateOf.get(p.id) ?? asked;
        const d = data.day(p.id, date);
        const focus = focusOfDay(d, now);
        const resolved = this.days.resolveWith(ctx, asShiftPerson(p), date);
        const shift = resolved.shift;
        const workday = isWorkdayFor(shift, date);
        const breakDay = this.days.forDate(resolved, date);
        // Leave (3.4): a full day expects nothing; a part day the rest of the shift.
        const leave = workday ? d.leave : undefined;
        const bounds = shift ? shiftBounds(shift, date, tz) : null;
        const mark = shiftAfterLeave(bounds?.start ?? null, bounds?.end ?? null, leave);
        // A day off shows its breaks only once the person has started it (3.2); leave
        // hides the breaks it covers (3.4). Biometric staff have no break flow (3.5).
        const biometric = p.attendanceSource === 'BIOMETRIC';
        const slots = (!biometric && (workday || d.sessions.length) ? breakDay.slots : []).filter(
          (slot) => {
            if (!leave?.mask || d.breakRecords.some((r) => r.kind === slot.kind)) return true;
            if (leave.full) return d.sessions.length > 0;
            const at = slot.scheduledStart.getTime();
            return (
              (!mark.start || at >= mark.start.getTime()) && (!mark.end || at < mark.end.getTime())
            );
          },
        );
        const hourly = activity
          ? this.dayData.bucketHourly(d, buckets, now, settings.quietHourActiveMin)
          : [];
        const first = d.sessions[0] ?? null;
        const last = d.sessions[d.sessions.length - 1] ?? null;
        const openSession = d.sessions.find((s) => s.endedAt === null) ?? null;
        const live0 = this.statusOf(d, openBy.get(p.id) ?? null, openSession, live);
        const { status, since } =
          live0.status === 'NOT_STARTED' && leave?.full
            ? { status: 'ON_LEAVE' as TeamRowStatus, since: null }
            : live0;
        const recordFor = (kind: string) => d.breakRecords.find((r) => r.kind === kind) ?? null;
        return {
          date,
          user: {
            id: p.id,
            name: personName(p),
            email: p.email,
            role: p.role,
            department: p.department,
            managerId: p.managerId,
          },
          status,
          statusSince: since,
          startedAt: first?.startedAt.toISOString() ?? null,
          endedAt: !openSession && last?.endedAt ? last.endedAt.toISOString() : null,
          autoClosed: !openSession && last?.endReason === 'AUTO_CLOSED',
          extended: d.sessions.some((s) => !!s.extendedAt),
          lateStart:
            workday && shift && first && !leave?.full
              ? lateStartDetail({
                  first,
                  shiftStart: mark.start,
                  graceMin: settings.lateStartGraceMin,
                  requireReason: settings.requireLateStartReason,
                  // 4.0: nobody approves an admin's day, so nobody asks why it started late.
                  exempt: ['SUPER_ADMIN', 'SUPER_MANAGER', 'ADMIN'].includes(p.role),
                })
              : null,
          // 4.0: holidays from the organisation calendar arrive with the calendar merge.
          dayOff: workday ? null : { kind: 'WEEKLY_OFF' as const, name: null },
          leave: workday ? dayLeaveView(d.leave) : null,
          focus: focusView(focus),
          expectedSec: workday ? expectedAfterLeave(expectedSecOf(shift), leave) : 0,
          breaks: slots.map((slot) => {
            const rec = recordFor(slot.kind);
            let cell: TeamBreakStatus;
            if (rec) {
              const outcome = outcomeOf(rec);
              cell = outcome !== 'TAKEN' ? outcome : rec.endedAt ? 'TAKEN' : 'IN_PROGRESS';
            } else {
              const phase = phaseAt(slot, now);
              cell = phase === 'UPCOMING' ? 'UPCOMING' : phase === 'CLOSED' ? 'MISSED' : 'OPEN';
            }
            return {
              kind: slot.kind,
              label: slot.label,
              status: cell,
              record: rec ? ShiftMapper.recordView(rec, now) : null,
            };
          }),
          meetings: meetingsOfDay(d, now),
          pending: pendingBy.get(`${p.id}|${date}`) ?? 0,
          hourly,
          quietHours: quietHoursOf(hourly),
          attendance: biometric ? 'BIOMETRIC' : 'AGENT',
          wfh: wfhDayView(d.wfh, {
            biometric,
            openSource: openSession?.source ?? null,
            dayIsToday: live,
          }),
          biometric: biometric ? this.punchSummary(punches.get(`${p.id}|${date}`) ?? [], d) : null,
        };
      });

    const count = (s: TeamRowStatus[]) => rows.filter((r) => s.includes(r.status)).length;
    return {
      date: asked,
      serverNow: now.toISOString(),
      totals: {
        people: rows.length,
        started: rows.filter((r) => r.startedAt !== null).length,
        notStarted: count(['NOT_STARTED']),
        onBreak: count(['BREAK', 'LUNCH']),
        inMeeting: count(['MEETING']),
        ended: count(['DAY_ENDED']),
        onLeave: count(['ON_LEAVE']),
        partLeave: rows.filter((r) => r.leave && r.leave.days > 0 && !r.leave.full).length,
        lateStarts: rows.filter((r) => r.lateStart).length,
        workingFromHome: rows.filter((r) => r.wfh && r.wfh.days > 0).length,
        biometric: rows.filter((r) => r.attendance === 'BIOMETRIC').length,
        pendingApprovals: rows.reduce((s, r) => s + r.pending, 0),
        overdueApprovals,
        focusSec: rows.reduce((s, r) => s + r.focus.focusSec, 0),
        quietHours: rows.reduce((s, r) => s + r.quietHours, 0),
      },
      rows,
    };
  }

  /** A biometric person's punches of the day, in short (3.5). */
  private punchSummary(list: DayPunch[], d: PersonDayData): TeamTodayRow['biometric'] {
    const valid = list.filter((p) => !p.voided);
    return {
      punches: valid.length,
      firstPunchAt: valid[0]?.at.toISOString() ?? null,
      lastPunchAt: valid.length > 1 ? valid[valid.length - 1].at.toISOString() : null,
      checkoutMissing: d.sessions.some(
        (s) => s.source === BIOMETRIC_SOURCE && s.endReason === 'AUTO_CLOSED',
      ),
    };
  }

  /**
   * Live status: an open break, lunch or meeting wins; then an open session is
   * WORKING; a day with closed sessions is DAY_ENDED; otherwise NOT_STARTED.
   */
  private statusOf(
    d: PersonDayData,
    open: PresenceRow | null,
    openSession: { startedAt: Date } | null,
    live: boolean,
  ): { status: TeamRowStatus; since: string | null } {
    if (live && open) return { status: open.type, since: open.startedAt.toISOString() };
    if (live && openSession) {
      const lastPresenceEnd = d.presence
        .map((p) => p.endedAt)
        .filter((e): e is Date => !!e && e > openSession.startedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return { status: 'WORKING', since: (lastPresenceEnd ?? openSession.startedAt).toISOString() };
    }
    if (d.sessions.length) {
      const ends = d.sessions.map((s) => s.endedAt).filter((e): e is Date => !!e);
      const last = ends.sort((a, b) => b.getTime() - a.getTime())[0];
      return { status: 'DAY_ENDED', since: last?.toISOString() ?? null };
    }
    return { status: 'NOT_STARTED', since: null };
  }
}
