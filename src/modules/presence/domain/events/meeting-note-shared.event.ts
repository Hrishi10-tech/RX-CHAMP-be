/**
 * Raised when an employee starts a MEETING presence session with a note. The
 * notifications module turns it into a persisted notification + realtime bell
 * update for whoever oversees them (4.0: department managers, or the Admin).
 */
export class MeetingNoteSharedEvent {
  static readonly eventName = 'presence.meeting-note-shared';

  constructor(
    /** 3.x reporting line, kept for compatibility; 4.0 routing ignores it. */
    public readonly managerId: string | null,
    /** The employee who sent it. */
    public readonly fromUserId: string,
    public readonly fromName: string,
    public readonly note: string,
    public readonly occurredAt: Date,
  ) {}
}
