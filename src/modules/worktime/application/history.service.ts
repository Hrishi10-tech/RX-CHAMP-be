import { Inject, Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '@shared/exceptions/app.exception';
import { AuthenticatedUser } from '@shared/rbac/authenticated-user';
import { appTimezone, dateKeyInZone, isoWeekdayOfKey } from '@shared/utils/timezone';
import { monthDates } from '@modules/reports/domain/report-builder';
import { meetingsOfDay } from '../domain/day';
import { WORKTIME_READER, WorktimeReader } from '../domain/worktime.reader';
import { awayView, AwayView } from './away.service';
import { PersonDaysService } from './person-days.service';

export interface HistoryDay {
  date: string;
  weekday: number;
  isWorkingDay: boolean;
  label: string | null;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  focusSec: number;
  targetSec: number;
  breakSec: number;
  paidBreakSec: number;
  unpaidBreakSec: number;
  meetings: number;
  meetingsSec: number;
  pendingSec: number;
  approvedAwaySec: number;
  /** Offline time with no activity data (not focus, not paid). */
  unverifiedSec: number;
  /** Payroll time: focusSec + paidBreakSec. */
  paidSec: number;
}

export interface HistoryView {
  month: string;
  isCurrent: boolean;
  workingDays: number;
  /** Working days up to and including today (the whole month for a past one). */
  elapsedWorkingDays: number;
  /** The month's focus target: Σ of every working day's target from the person's first day. */
  targetSec: number;
  /** Σ of the targets of working days up to today: what "on track" compares with. */
  targetToDateSec: number;
  focusSec: number;
  paidBreakSec: number;
  unpaidBreakSec: number;
  meetingsSec: number;
  pendingSec: number;
  unverifiedSec: number;
  paidSec: number;
  /** Focus at this pace by the month's end (focus / elapsed working days × working days). */
  projectedSec: number;
  days: HistoryDay[];
  meetings: {
    date: string;
    startedAt: string;
    durationSec: number;
    agenda: string;
    participants: { id?: string; name: string }[];
    momSender: string | null;
    status: string;
    kind: 'MEETING' | 'AWAY_MEETING';
  }[];
  away: (AwayView & { reason: string | null })[];
}

/**
 * The agent's History (docs/4.0/SPEC.md 2.7, 5.6): the month computed live from
 * the focus engine, so a decision made later changes the past day at once.
 */
@Injectable()
export class HistoryService {
  constructor(
    @Inject(WORKTIME_READER) private readonly reader: WorktimeReader,
    private readonly days: PersonDaysService,
  ) {}

  async month(me: AuthenticatedUser, month: string | undefined, now: Date): Promise<HistoryView> {
    const tz = appTimezone();
    const today = dateKeyInZone(now, tz);
    const current = today.slice(0, 7);
    const m = month ?? current;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) {
      throw new ValidationError('Use a month like 2026-10.').withDetails({ field: 'month' });
    }
    if (m > current)
      throw new ValidationError('That month has not started yet.').withDetails({ field: 'month' });
    if (m < '2020-01')
      throw new ValidationError('That month is too long ago.').withDetails({ field: 'month' });

    const [person] = await this.reader.listPeople({ ids: [me.id] });
    if (!person) throw new NotFoundError('User not found');
    const dates = monthDates(m);
    const set = await this.days.load([person], dates[0], dates[dates.length - 1], now, {
      heal: true,
    });

    const days: HistoryDay[] = [];
    const meetings: HistoryView['meetings'] = [];
    const away: HistoryView['away'] = [];
    let workingDays = 0;
    let elapsedWorkingDays = 0;
    let targetSec = 0;
    let targetToDateSec = 0;
    let focusSec = 0;
    let paidBreakSec = 0;
    let unpaidBreakSec = 0;
    let meetingsSec = 0;
    let pendingSec = 0;
    let unverifiedSec = 0;
    let paidSec = 0;

    for (const date of dates) {
      const day = set.day(person, date);
      const s = day.summary;
      const counted = s.workday; // working day for this person (calendar, and after joining)
      if (counted) {
        workingDays += 1;
        targetSec += s.targetSec;
        if (date <= today) {
          elapsedWorkingDays += 1;
          targetToDateSec += s.targetSec;
        }
      }
      const ms = meetingsOfDay(day.data, now);
      focusSec += s.focusSec;
      paidBreakSec += s.paidBreakSec;
      unpaidBreakSec += s.unpaidBreakSec;
      meetingsSec += ms.sec;
      pendingSec += s.pendingPlusSec;
      unverifiedSec += s.unverifiedSec;
      paidSec += s.paidSec;
      days.push({
        date,
        weekday: isoWeekdayOfKey(date),
        isWorkingDay: day.plan.isWorkingDay,
        label: day.plan.label,
        status: s.dayClass,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        focusSec: s.focusSec,
        targetSec: counted ? s.targetSec : 0,
        breakSec: s.breakSec,
        paidBreakSec: s.paidBreakSec,
        unpaidBreakSec: s.unpaidBreakSec,
        meetings: ms.count,
        meetingsSec: ms.sec,
        pendingSec: s.pendingPlusSec,
        approvedAwaySec: s.awayApprovedSec,
        unverifiedSec: s.unverifiedSec,
        paidSec: s.paidSec,
      });
      for (const r of day.data.meetingRecords) {
        meetings.push({
          date,
          startedAt: r.startedAt.toISOString(),
          durationSec:
            r.durationSec ??
            Math.max(0, Math.round(((r.endedAt ?? now).getTime() - r.startedAt.getTime()) / 1000)),
          agenda: r.agenda,
          participants: r.participants,
          momSender: r.momSender ?? null,
          status: r.approvalStatus,
          kind: 'MEETING',
        });
      }
      for (const a of day.data.away ?? []) {
        const v = awayView(a);
        away.push({ ...v, reason: a.reasonLabel });
        if (a.reasonKind === 'MEETING') {
          meetings.push({
            date,
            startedAt: v.startedAt,
            durationSec: v.seconds,
            agenda: a.comment ?? 'Short meeting',
            participants: v.participants,
            momSender: a.momSender,
            status: a.status,
            kind: 'AWAY_MEETING',
          });
        }
      }
    }
    meetings.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const projectedSec =
      m < current || elapsedWorkingDays === 0
        ? focusSec
        : Math.round((focusSec / elapsedWorkingDays) * workingDays);
    return {
      month: m,
      isCurrent: m === current,
      workingDays,
      elapsedWorkingDays,
      targetSec,
      targetToDateSec,
      focusSec,
      paidBreakSec,
      unpaidBreakSec,
      meetingsSec,
      pendingSec,
      unverifiedSec,
      paidSec,
      projectedSec,
      days,
      meetings,
      away,
    };
  }
}
