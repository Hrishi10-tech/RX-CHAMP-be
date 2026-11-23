import { BreakOutcome, BreakTiming, RecordKind } from '../shift.types';

/** A break needs a decision; tells whoever must decide it. */
export class BreakApprovalRequestedEvent {
  static readonly eventName = 'break.approval-requested';
  constructor(
    public readonly recordId: string,
    public readonly subjectId: string,
    public readonly subjectName: string,
    /** People to notify (the routed approver, or every Super Admin for the pool). */
    public readonly recipientIds: string[],
    public readonly kind: RecordKind | null,
    public readonly timing: BreakTiming,
    public readonly minutesOff: number,
    public readonly reason: string | null,
    public readonly overrun: boolean,
    public readonly at: Date,
    /** A skip sent again to a new approver stays a skip: it was never a break taken. */
    public readonly outcome: BreakOutcome = 'TAKEN',
    /** When it began, or when it was skipped: an auto-skip's notice names the time. */
    public readonly startedAt: Date = at,
  ) {}
}
