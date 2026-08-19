/**
 * Raised when one user sends another a chat message. The notifications module
 * subscribes to turn it into a persisted notification + a bell/toast push, so a
 * recipient who is anywhere other than the chat screen still finds out. The chat
 * socket itself only reaches clients that have the conversation open.
 */
export class ChatMessageSentEvent {
  static readonly eventName = 'chat.message-sent';

  constructor(
    /** Who the message is addressed to — the notification's owner. */
    public readonly toUserId: string,
    public readonly fromUserId: string,
    public readonly fromName: string,
    public readonly messageId: string,
    public readonly body: string,
    public readonly occurredAt: Date,
  ) {}
}
