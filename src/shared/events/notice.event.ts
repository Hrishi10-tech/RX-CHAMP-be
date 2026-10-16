/**
 * A ready-written notification for one or more people. Modules that already
 * know the copy publish this instead of a bespoke event; the notifications
 * module stores one row per recipient and pushes it to their bell in realtime.
 */
export class NoticeEvent {
  static readonly eventName = 'notice.send';

  constructor(
    public readonly recipientIds: string[],
    /** The notification `type` the clients route on (e.g. SKIP_REQUESTED). */
    public readonly type: string,
    public readonly title: string,
    public readonly body: string | null,
    /** The person behind it, when there is one (never the recipient). */
    public readonly fromUserId: string | null = null,
  ) {}
}
