import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { BreakRecordRow, outcomeOf } from '../domain/break-record.repository';
import { BreakApprovalRequestedEvent } from '../domain/events/break-approval-requested.event';
import { BreakDecidedEvent } from '../domain/events/break-decided.event';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader, ShiftPerson } from '../domain/shift-people.reader';

export function personName(
  p: Pick<ShiftPerson, 'firstName' | 'lastName'> | null | undefined,
): string {
  return p ? `${p.firstName} ${p.lastName}`.trim() : 'Someone';
}

/** Publishes break events with the right recipients. Never throws into the caller. */
@Injectable()
export class BreakEvents {
  private readonly logger = new Logger(BreakEvents.name);

  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
  ) {}

  /** Who must decide a pending record: the routed approver, or every Super Admin. */
  async recipientsFor(
    record: Pick<BreakRecordRow, 'userId' | 'approverId' | 'approverRole'>,
  ): Promise<string[]> {
    if (record.approverId) return record.approverId === record.userId ? [] : [record.approverId];
    if (record.approverRole === 'SUPER_ADMIN') {
      return (await this.people.listSuperAdminIds()).filter((id) => id !== record.userId);
    }
    return [];
  }

  async approvalRequested(
    record: BreakRecordRow,
    subject: ShiftPerson,
    overrun: boolean,
  ): Promise<void> {
    try {
      if (record.approvalStatus !== 'PENDING') return;
      const recipients = await this.recipientsFor(record);
      if (!recipients.length) return;
      await this.events.publish(
        BreakApprovalRequestedEvent.eventName,
        new BreakApprovalRequestedEvent(
          record.id,
          subject.id,
          personName(subject),
          recipients,
          record.kind,
          record.timing,
          record.minutesOff,
          overrun ? record.overrunReason : record.reason,
          overrun,
          new Date(),
        ),
      );
    } catch (err) {
      this.logger.warn(`approval request event for ${record.id} failed: ${(err as Error).message}`);
    }
  }

  async decided(record: BreakRecordRow, decider: { id: string; name: string }): Promise<void> {
    try {
      if (record.approvalStatus !== 'APPROVED' && record.approvalStatus !== 'REJECTED') return;
      await this.events.publish(
        BreakDecidedEvent.eventName,
        new BreakDecidedEvent(
          record.id,
          record.userId,
          record.approvalStatus,
          decider.id,
          decider.name,
          record.kind,
          record.date,
          record.decisionNote,
          new Date(),
          outcomeOf(record),
        ),
      );
    } catch (err) {
      this.logger.warn(`decision event for ${record.id} failed: ${(err as Error).message}`);
    }
  }
}
