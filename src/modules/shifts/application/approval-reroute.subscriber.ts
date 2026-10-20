import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { UserAccessChangedEvent } from '@modules/users/domain/events/user-access-changed.event';
import {
  BREAK_RECORD_REPOSITORY,
  BreakRecordRepository,
  BreakRecordRow,
} from '../domain/break-record.repository';
import { SHIFT_PEOPLE_READER, ShiftPeopleReader, ShiftPerson } from '../domain/shift-people.reader';
import { BreakApprovalPolicy } from './break-approval.policy';
import { BreakEvents } from './break-events.service';

/** Most pending records handled per change (a backlog that large is reviewed in bulk anyway). */
const BATCH = 500;

/**
 * Keeps pending break approvals with someone who can decide them.
 *
 *  - An approver is blocked, deleted or demoted to staff: what waited on them
 *    is routed again (their staff now go to the Super Admin pool or a new manager).
 *  - A person gets a new manager or a new role: their own pending breaks follow.
 */
@Injectable()
export class ApprovalRerouteSubscriber implements OnModuleInit {
  private readonly logger = new Logger(ApprovalRerouteSubscriber.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(BREAK_RECORD_REPOSITORY) private readonly records: BreakRecordRepository,
    @Inject(SHIFT_PEOPLE_READER) private readonly people: ShiftPeopleReader,
    private readonly events: BreakEvents,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.handle(e),
    );
  }

  async handle(e: UserAccessChangedEvent): Promise<void> {
    const person = await this.people.findById(e.userId);
    const canApprove =
      !!person &&
      person.active &&
      (person.role === 'MANAGER' || person.role === 'ADMIN' || person.role === 'SUPER_ADMIN');

    let moved = 0;
    if (!canApprove) {
      const waiting = await this.records.listApprovals({
        approverId: e.userId,
        status: ['PENDING'],
        take: BATCH,
      });
      moved += await this.rerouteAll(waiting);
    }
    if (person && (e.changes.includes('MANAGER') || e.changes.includes('ROLE'))) {
      const own = await this.records.listApprovals({
        userId: e.userId,
        status: ['PENDING'],
        take: BATCH,
      });
      moved += await this.rerouteAll(own);
    }
    if (moved)
      this.logger.log(`re-routed ${moved} pending break approval(s) after a change to ${e.userId}`);
  }

  private async rerouteAll(rows: BreakRecordRow[]): Promise<number> {
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
      const route = BreakApprovalPolicy.route(subject);
      if (route.status !== 'PENDING') continue; // a Super Admin's own: nothing to approve, leave as is
      if (route.approverId === r.approverId && route.approverRole === r.approverRole) continue;
      if (
        await this.records.reroute(r.id, {
          approverRole: route.approverRole,
          approverId: route.approverId,
        })
      ) {
        moved += 1;
        const updated = await this.records.findById(r.id);
        if (updated)
          await this.events.approvalRequested(
            updated,
            subject,
            !!updated.overrunReason && !updated.reason,
          );
      }
    }
    return moved;
  }
}
