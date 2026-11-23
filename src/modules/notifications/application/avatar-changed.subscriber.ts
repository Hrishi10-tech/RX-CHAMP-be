import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { AvatarChangedEvent } from '@shared/events/avatar-changed.event';
import { EVENT_BUS, EventBus } from '@shared/events/event-bus.port';
import { NotificationsGateway } from '../presentation/notifications.gateway';

/**
 * Passes avatar changes to the open apps of the person and of those shown them, as
 * `avatar:changed` on the /notifications socket (NotificationsGateway.emitAvatar).
 */
@Injectable()
export class AvatarChangedSubscriber implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly events: EventBus,
    private readonly gateway: NotificationsGateway,
  ) {}

  onModuleInit(): void {
    this.events.subscribe<AvatarChangedEvent>(AvatarChangedEvent.eventName, (e) =>
      this.gateway.emitAvatar(e.userId, e.avatarId),
    );
  }
}
