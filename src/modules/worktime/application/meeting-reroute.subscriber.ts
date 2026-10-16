import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@modules/users/domain/events/user-access-changed.event';
import { BreakApprovalPolicy } from '@modules/shifts/application/break-approval.policy';
import {
  SHIFT_PEOPLE_READER,
  ShiftPeopleReader,
  ShiftPerson,
} from '@modules/shifts/domain/shift-people.reader';
import {
  MEETING_RECORD_REPOSITORY,
  MeetingRecordRepository,
  MeetingRecordRow,
} from '../domain/meeting-record.repository';

/**
 * Keeps pending meeting approvals with someone who can decide them, exactly as
 * ApprovalRerouteSubscriber does for break records: an approver who is blocked,
 * deleted or demoted hands their queue on; a person's own pending meetings follow
 * a new manager or role.
 */
@Injectable()
export class MeetingRerouteSubscriber implements OnModuleInit {
  private readonly logger = new Logger(MeetingRerouteSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(MEETING_RECORD_REPOSITORY) private readonly meetings: MeetingRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  async handle(e: UserAccessChangedEvent): Promise<void> {
    const person = await this.people.findById(e.userId);
    const canApprove =
      !!person && person.active && (person.role === 'MANAGER' || person.role === 'SUPER_ADMIN');
    let moved = 0;
    if (!canApprove)
      moved += await this.rerouteAll(await this.meetings.listPendingForApprover(e.userId));
    if (person && (e.changes.includes('MANAGER') || e.changes.includes('ROLE'))) {
      moved += await this.rerouteAll(await this.meetings.listPendingForUser(e.userId));
    }
    if (moved)
      this.logger.log(
        `re-routed ${moved} pending meeting approval(s) after a change to ${e.userId}`,
      );
  }

  private async rerouteAll(rows: MeetingRecordRow[]): Promise<number> {
    let moved = 0;
    const cache = new Map<string, ShiftPerson | null>();
    const find = async (id: string | null) => {
      if (!id) return null;
      if (!cache.has(id)) cache.set(id, await this.people.findById(id));
      return cache.get(id) ?? null;
    };
    for (const r of rows) {
      const subject = await find(r.userId);
      if (!subject) continue;
      const route = BreakApprovalPolicy.route(subject, await find(subject.managerId));
      if (route.status !== 'PENDING') continue;
      if (route.approverId === r.approverId && route.approverRole === r.approverRole) continue;
      if (
        await this.meetings.reroute(r.id, {
          approverRole: route.approverRole,
          approverId: route.approverId,
        })
      ) {
        moved += 1;
      }
    }
    return moved;
  }
}
