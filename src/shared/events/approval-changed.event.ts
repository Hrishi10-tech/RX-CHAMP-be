/**
 * The kinds of approval item (the `what` of the socket event). 4.0 adds AWAY: away time
 * the agent's pop-up sent for approval (docs/4.0/SPEC.md 2.5).
 */
export type ApprovalWhat = 'BREAK' | 'MEETING' | 'AWAY' | 'LEAVE' | 'WFH' | 'COMPOFF';

/**
 * CREATED: a new request (or one newly routed to someone). DECIDED: approved or
 * rejected. REVOKED: an approved one taken back. REOPENED: back to pending.
 * CANCELLED: withdrawn by the person. UPDATED: its details changed (a comment, its
 * end, a due time passed, who it waits on).
 */
export type ApprovalAction =
  | 'CREATED'
  | 'DECIDED'
  | 'REVOKED'
  | 'REOPENED'
  | 'CANCELLED'
  | 'UPDATED';

export interface ApprovalChange {
  what: ApprovalWhat;
  id: string;
  action: ApprovalAction;
  /**
   * Whoever it waited on until this change (4.0: the managers of the department it
   * left, or a manager who left the department): they may no longer see it, so
   * nothing else tells them. Always people of the item's own organisation.
   */
  formerApprovers?: string[];
}

/**
 * An approval item changed (3.6). The approval-sync module turns this into the
 * socket event `approvals:changed` for everyone who can see the item and, for a new
 * request, a push to whoever decides it.
 */
export class ApprovalChangedEvent implements ApprovalChange {
  static readonly eventName = 'approval.changed';

  constructor(
    public readonly what: ApprovalWhat,
    public readonly id: string,
    public readonly action: ApprovalAction,
    public readonly at: string = new Date().toISOString(),
    public readonly formerApprovers: string[] = [],
  ) {}
}
