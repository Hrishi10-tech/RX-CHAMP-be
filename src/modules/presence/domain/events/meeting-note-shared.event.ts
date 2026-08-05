/**
 * Raised when an employee starts a MEETING presence session with a note for
 * their manager. The notifications module subscribes to turn this into a
 * persisted notification + realtime bell update for the manager.
 */
export class MeetingNoteSharedEvent {
  static readonly eventName = 'presence.meeting-note-shared';

  constructor(
    /** The manager who should receive the note. */
    public readonly managerId: string,
    /** The employee who sent it. */
    public readonly fromUserId: string,
    public readonly fromName: string,
    public readonly note: string,
    public readonly occurredAt: Date,
  ) {}
}
