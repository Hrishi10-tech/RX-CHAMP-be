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

  /**
   * Who must decide a pending item (docs/4.0/SPEC.md 1.3): the Managers of the
   * subject's department for MANAGER items (the organisation's Admin when the
   * department has none), the Admin for ADMIN items. Never the subject.
   */
  async recipientsFor(record: Pick<BreakRecordRow, 'userId' | 'approverRole'>): Promise<string[]> {
    if (!record.approverRole) return [];
    const subject = await this.people.findById(record.userId);
    if (!subject?.companyId) return [];
    let ids: string[] = [];
    if (record.approverRole === 'MANAGER' && subject.departmentId) {
      ids = await this.people.listDepartmentManagerIds(subject.departmentId);
    }
    if (!ids.length) ids = await this.people.listOrgAdminIds(subject.companyId);
    return ids.filter((id) => id !== record.userId);
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
