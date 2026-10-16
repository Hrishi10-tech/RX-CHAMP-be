import { BreakKind, BreakTiming } from '../shift.types';

/** A break needs a decision; tells whoever must decide it. */
export class BreakApprovalRequestedEvent {
  static readonly eventName = 'break.approval-requested';
  constructor(
    public readonly recordId: string,
    public readonly subjectId: string,
    public readonly subjectName: string,
    /** People to notify (the routed approver, or every Super Admin for the pool). */
    public readonly recipientIds: string[],
    public readonly kind: BreakKind | null,
    public readonly timing: BreakTiming,
    public readonly minutesOff: number,
    public readonly reason: string | null,
    public readonly overrun: boolean,
    public readonly at: Date,
  ) {}
}
