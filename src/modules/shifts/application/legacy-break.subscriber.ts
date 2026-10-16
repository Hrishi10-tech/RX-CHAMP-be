import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { PresenceStartedEvent } from '@modules/presence/domain/events/presence-started.event';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  NewBreakRecord,
} from '../domain/break-record.repository';
import { classifyStart, phaseAt } from '../domain/break-schedule';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader } from '../domain/shift-people.reader';
import { BreakSlot } from '../domain/shift.types';
import { BreakApprovalPolicy } from './break-approval.policy';
import { BreakDayService } from './break-day.service';
import { BreakEvents } from './break-events.service';

/**
 * Keeps oversight when a break starts through POST /presence/start: an agent
 * older than scheduled breaks, or any client using the plain status buttons.
 *
 * On a scheduled day the break is matched to the slot whose window is open and
 * judged exactly like the new flow. If no window is open it is recorded as off
 * schedule and sent for approval, so the older path cannot be used to skip the
 * rules. On a free day (no shift, day off, no breaks) nothing is recorded.
 */
@Injectable()
export class LegacyBreakSubscriber implements OnModuleInit {
  private readonly logger = new Logger(LegacyBreakSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly records: BreakRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly days: BreakDayService,
    private readonly events: BreakEvents,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PresenceStartedEvent>(PresenceStartedEvent.eventName, (e) => this.handle(e));
  }

  async handle(e: PresenceStartedEvent): Promise<void> {
    if (e.type !== 'BREAK' && e.type !== 'LUNCH') return;
    const person = await this.people.findById(e.userId);
    if (!person) return;

    const day = await this.days.dayFor(person, e.at);
    const shift = day.resolved.shift;
    if (!shift || !day.workday || !day.slots.length) return;

    const taken = await this.records.listForUserOnDate(person.id, day.dateKey);
    const takenKinds = new Set(taken.map((r) => r.kind).filter(Boolean));
    const sameType = day.slots.filter((s) => s.presenceType === e.type);
    const open = sameType.find((s) => {
      if (takenKinds.has(s.kind)) return false;
      const phase = phaseAt(s, e.at);
      return phase !== 'UPCOMING' && phase !== 'CLOSED';
    });

    const manager = person.managerId ? await this.people.findById(person.managerId) : null;
    let record: NewBreakRecord;

    if (open) {
      const judged = classifyStart(open, e.at, shift);
      const route = judged.reasonRequired
        ? BreakApprovalPolicy.route(person, manager)
        : { status: 'NOT_REQUIRED' as const, approverRole: null, approverId: null };
      record = this.base(person.id, day.dateKey, open, shift, e);
      record.kind = open.kind;
      record.timing = judged.timing;
      record.minutesOff = judged.minutesOff;
      record.approvalStatus = route.status;
      record.approverRole = route.approverRole;
      record.approverId = route.approverId;
    } else {
      // No window open for this kind of break: off schedule.
      const nearest = sameType
        .slice()
        .sort(
          (a, b) =>
            Math.abs(a.scheduledStart.getTime() - e.at.getTime()) -
            Math.abs(b.scheduledStart.getTime() - e.at.getTime()),
        )[0];
      const route = BreakApprovalPolicy.route(person, manager);
      record = this.base(person.id, day.dateKey, nearest ?? null, shift, e);
      record.kind = null;
      record.timing = nearest ? 'OUTSIDE_WINDOW' : 'UNSCHEDULED';
      record.minutesOff = nearest
        ? Math.round(Math.abs(e.at.getTime() - nearest.scheduledStart.getTime()) / 60_000)
        : 0;
      record.approvalStatus = route.status;
      record.approverRole = route.approverRole;
      record.approverId = route.approverId;
    }

    const created = await this.records.createForSession(record, e.sessionId);
    if (!created) return;
    this.logger.debug(
      `recorded ${e.type} for ${person.id} via presence/start as ${created.timing}`,
    );
    if (created.approvalStatus === 'PENDING')
      await this.events.approvalRequested(created, person, false);
  }

  private base(
    userId: string,
    date: string,
    slot: BreakSlot | null,
    shift: { id: string; name: string },
    e: PresenceStartedEvent,
  ): NewBreakRecord {
    return {
      userId,
      date,
      kind: null,
      presenceType: e.type === 'LUNCH' ? 'LUNCH' : 'BREAK',
      shiftId: shift.id,
      shiftName: shift.name,
      scheduledStart: slot?.scheduledStart ?? null,
      durationMin: slot?.durationMin ?? null,
      windowOpen: slot?.windowOpen ?? null,
      windowClose: slot?.windowClose ?? null,
      ringStart: slot?.ringStart ?? null,
      ringEnd: slot?.ringEnd ?? null,
      startedAt: e.at,
      timing: 'UNSCHEDULED',
      minutesOff: 0,
      reason: null,
      source: 'LEGACY',
      approvalStatus: 'NOT_REQUIRED',
      approverRole: null,
      approverId: null,
    };
  }
}
