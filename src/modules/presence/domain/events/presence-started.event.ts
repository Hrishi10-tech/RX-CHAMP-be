import { PresenceKind } from '../presence-session.repository';

/**
 * Someone started a break, lunch or meeting through POST /presence/start (the
 * older flow). The shifts module listens so that a break started by an agent
 * that predates scheduled breaks is still recorded and, if it was off schedule,
 * sent for approval.
 */
export class PresenceStartedEvent {
  static readonly eventName = 'presence.started';
  constructor(
    public readonly userId: string,
    public readonly sessionId: string,
    public readonly type: PresenceKind,
    public readonly at: Date,
  ) {}
}
