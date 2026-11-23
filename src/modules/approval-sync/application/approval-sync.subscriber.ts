import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ApprovalChange, ApprovalChangedEvent } from '@shared/events/approval-changed.event';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NoticeEvent } from '@shared/events/notice.event';
import { UserAccessChangedEvent } from '@shared/events/user-access-changed.event';
import { NotificationsGateway } from '@modules/notifications/presentation/notifications.gateway';
import { PushService } from '@modules/push/application/push.service';
import { BreakApprovalRequestedEvent } from '@modules/shifts/domain/events/break-approval-requested.event';
import { approvalPushCopy } from '../domain/approval-push-copy';
import { ApprovalAudienceService } from './approval-audience.service';

/**
 * Keeps every open client in step (3.6). Each change to an approval item becomes the
 * socket event `approvals:changed` for everyone who can see the item, on the web and
 * on the phone, and a new request also becomes a push to whoever decides it.
 *
 * Changes arrive from ApprovalChangeInterceptor (requests over HTTP) and from the
 * events raised where a break, meeting or away time comes to need a decision, which
 * can happen away from any request (the auto-skip job, a meeting closed on read).
 *
 * 4.0: who sees and decides an item comes from department routing
 * (ApprovalAudienceService), and every socket event goes to a person's own room, so
 * nothing reaches another organisation.
 */
@Injectable()
export class ApprovalSyncSubscriber implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly audience: ApprovalAudienceService,
    private readonly gateway: NotificationsGateway,
    private readonly push: PushService,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<ApprovalChangedEvent>(ApprovalChangedEvent.eventName, (e) =>
      this.handle(e),
    );
    this.events.subscribe<NoticeEvent>(NoticeEvent.eventName, (e) =>
      e.approval ? this.publish(e.approval) : undefined,
    );
    this.events.subscribe<BreakApprovalRequestedEvent>(BreakApprovalRequestedEvent.eventName, (e) =>
      this.publish({ what: 'BREAK', id: e.recordId, action: 'CREATED' }),
    );
    this.events.subscribe<UserAccessChangedEvent>(UserAccessChangedEvent.eventName, (e) =>
      this.rerouted(e),
    );
  }

  private publish(c: ApprovalChange): Promise<void> {
    return this.events.publish(
      ApprovalChangedEvent.eventName,
      new ApprovalChangedEvent(c.what, c.id, c.action, undefined, c.formerApprovers),
    );
  }

  /**
   * 4.0: someone moved to another department or role, or a Manager gained or lost a
   * department (or was blocked, back or deleted): requests routed by department now
   * wait on someone new. Nothing is written to them, so nothing else would say so.
   * Breaks and meetings whose route is rewritten announce their own re-routing.
   */
  private async rerouted(e: UserAccessChangedEvent): Promise<void> {
    for (const item of await this.audience.movedBy(e)) await this.publish(item);
  }

  async handle(e: ApprovalChangedEvent): Promise<void> {
    const audience = await this.audience.of(e.what, e.id);
    if (!audience) return;
    const change = { what: e.what, id: e.id, action: e.action, at: e.at };
    const deciders = audience.status === 'PENDING' ? audience.deciders : [];
    const waiting = new Set(deciders);
    this.gateway.emitApprovals(deciders, { ...change, needsYou: true });
    this.gateway.emitApprovals(
      [...new Set([...audience.viewers, ...e.formerApprovers])].filter((id) => !waiting.has(id)),
      { ...change, needsYou: false },
    );
    if (e.action !== 'CREATED') return;
    const copy = approvalPushCopy(e.what);
    await Promise.all(
      deciders.map((recipientId) =>
        this.push.send({
          recipientId,
          ...copy,
          data: { type: 'APPROVAL_REQUEST', what: e.what, id: e.id },
        }),
      ),
    );
  }
}
