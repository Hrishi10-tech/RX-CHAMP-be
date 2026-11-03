import { RecordKind, BreakOutcome } from '../shift.types';

/** A break record was approved or rejected; tells the person who took (or skipped) it. */
export class BreakDecidedEvent {
  static readonly eventName = 'break.decided';
  constructor(
    public readonly recordId: string,
    public readonly subjectId: string,
    public readonly decision: 'APPROVED' | 'REJECTED',
    public readonly deciderId: string,
    public readonly deciderName: string,
    public readonly kind: RecordKind | null,
    public readonly date: string,
    public readonly note: string | null,
    public readonly at: Date,
    /** 3.1: a skip reads "Your skipped morning break ..." */
    public readonly outcome: BreakOutcome = 'TAKEN',
    /**
     * 3.3: what the decision did to the day's focus time, so the person is told
     * in the same breath. PLUS: overrun minutes added back; MINUS: a rejected skip;
     * KEPT: an approved skip (the minutes worked through the break stay counted);
     * NONE: nothing changes (an early or late start, a rejected overrun ask).
     */
    public readonly effect: {
      mode: 'PLUS' | 'MINUS' | 'KEPT' | 'NONE';
      minutes: number;
    } | null = null,
  ) {}
}
