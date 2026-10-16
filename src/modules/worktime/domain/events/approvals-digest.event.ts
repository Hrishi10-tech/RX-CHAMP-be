/**
 * The daily reminder (18:30 business time): how many decisions are waiting for
 * one approver, how many of those are due within 24 hours and how many are
 * overdue. Counts break and meeting records together.
 */
export class ApprovalsDigestEvent {
  /** The 3.0 event name, kept so the subscriber wiring is unchanged. */
  static readonly eventName = 'break.approvals-digest';
  constructor(
    public readonly recipientId: string,
    public readonly pending: number,
    /** Pending and due within 24 hours (not yet overdue). */
    public readonly dueSoon: number,
    public readonly overdue: number,
    public readonly date: string,
  ) {}
}
