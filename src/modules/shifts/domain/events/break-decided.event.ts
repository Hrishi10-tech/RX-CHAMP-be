import { BreakKind, BreakOutcome } from '../shift.types';

/** A break record was approved or rejected; tells the person who took (or skipped) it. */
export class BreakDecidedEvent {
  static readonly eventName = 'break.decided';
  constructor(
    public readonly recordId: string,
    public readonly subjectId: string,
    public readonly decision: 'APPROVED' | 'REJECTED',
    public readonly deciderId: string,
    public readonly deciderName: string,
    public readonly kind: BreakKind | null,
    public readonly date: string,
    public readonly note: string | null,
    public readonly at: Date,
    /** 3.1: a skip reads "Your skipped morning break ..." */
    public readonly outcome: BreakOutcome = 'TAKEN',
  ) {}
}
